// The storyboard: the home of a scene. A wrapping grid of panels, read like a comic page.
// Each panel shows a sketch (or a frame of its shot once animated), free-text notes and a duration.
// Everything here is undoable, so nothing asks for confirmation.
import { uid } from '../model/shot';
import {
  byFileName, dropOrphanClips, isActed, movePanel, sizeOf, newPanel, panelSeconds, setPanelSeconds, summary, type Panel, type Storyboard,
} from '../model/storyboard';
import type { CharacterEntry, Project } from '../project/project';
import { pictures } from '../render/thumb';
import { h } from './dom';
import { EASE_OUT, enter } from './motion';
import { clearSample } from './sample';
import { openExport } from './exportDialog';
import { compileScene, resizeCamera, SIZES, sizeLabel, type ProjectSize } from '../model/scene';

export interface StoryboardContext {
  project: Project;
  onChanged: () => void;
  /** Open the panel's shot in the editor, making the shot first if it has none. */
  openPanel: (panel: Panel) => void;
  /** The Characters screen: import art and set joints. */
  characters: () => void;
  menu: () => { label: string; run: () => void }[];
  saveState: () => string;
  status: () => string;
}

interface Snapshot { sb: string; shots: string; chars: CharacterEntry[]; sketches: [string, Uint8Array][] }

const IMAGE = /^image\//;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class StoryboardView {
  private sb: Storyboard;
  private selected: string | null = null;
  private editing: { id: string; field: 'notes' | 'duration' } | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private sketchUrls = new Map<string, { bytes: Uint8Array; url: string }>();
  private root = h('div', { class: 'storyboard' });
  private grid = h('div', { class: 'sb-grid', role: 'list', 'aria-label': 'Panels' });
  private top = h('header', { class: 'sb-top' });
  private hint = h('footer', { class: 'hint' }, 'Double-click a scene to open it. Drag to reorder. Ctrl+D duplicates, Delete removes, Ctrl+V pastes a sketch.');
  private toastEl = h('div', { class: 'toast', role: 'status', hidden: true });
  private toastTimer = 0;
  private disposers: (() => void)[] = [];

  constructor(host: HTMLElement, private ctx: StoryboardContext) {
    this.sb = ctx.project.storyboard!;
    this.root.append(this.top, h('main', { class: 'sb-scroll' }, this.grid), this.hint, this.toastEl);
    host.replaceChildren(this.root);
    this.bind();
    this.render();
  }

  // --- undo ------------------------------------------------------------------------
  private snapshot(): Snapshot {
    const { project } = this.ctx;
    return {
      sb: JSON.stringify(project.storyboard), shots: JSON.stringify(project.shots), chars: [...project.characters],
      sketches: [...project.assets].filter(([p]) => p.startsWith('sketches/')),
    };
  }
  private restore(s: Snapshot) {
    const { project } = this.ctx;
    project.storyboard = this.sb = JSON.parse(s.sb);
    project.shots = JSON.parse(s.shots);
    project.characters = [...s.chars];
    for (const p of [...project.assets.keys()]) if (p.startsWith('sketches/')) project.assets.delete(p);
    for (const [p, b] of s.sketches) project.assets.set(p, b);
    if (this.selected && !this.sb.panels.some((p) => p.id === this.selected)) this.selected = null;
    this.ctx.onChanged();
  }
  /** Run a change as one undoable step. `animate` moves panels to their new places (pointer actions only). */
  private change(run: () => void, animate = false) {
    const before = this.snapshot();
    const rects = animate ? this.rects() : null;
    run();
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.ctx.onChanged();
    this.render();
    if (rects) this.flip(rects);
  }
  undo = () => {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this.render();
  };
  redo = () => {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this.render();
  };

  // --- motion ----------------------------------------------------------------------
  private rects() {
    return new Map([...this.grid.querySelectorAll<HTMLElement>('.sb-panel')].map((el) => [el.dataset.id!, el.getBoundingClientRect()]));
  }
  /** Panels glide from where they were to where they are now; new ones grow in. Occasional, so it may move. */
  private flip(before: Map<string, DOMRect>) {
    if (reduced()) return;
    for (const el of this.grid.querySelectorAll<HTMLElement>('.sb-panel')) {
      const was = before.get(el.dataset.id!), now = el.getBoundingClientRect();
      if (!was) { enter(el, 'scale(0.95)', 180); continue; }
      const dx = was.left - now.left, dy = was.top - now.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: EASE_OUT });
    }
  }

  // --- helpers ---------------------------------------------------------------------
  private index(id: string) { return this.sb.panels.findIndex((p) => p.id === id); }
  private panel(id: string | null) { return this.sb.panels.find((p) => p.id === id) ?? null; }
  private animated(p: Panel) { return isActed(p); }

  private sketchUrl(file: string): string | null {
    const bytes = this.ctx.project.assets.get(`sketches/${file}`);
    if (!bytes) return null;
    const hit = this.sketchUrls.get(file);
    if (hit?.bytes === bytes) return hit.url;
    if (hit) URL.revokeObjectURL(hit.url);
    const type = /\.svg$/i.test(file) ? 'image/svg+xml' : '';
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], type ? { type } : {}));
    this.sketchUrls.set(file, { bytes, url });
    return url;
  }

  /** Store image files as sketches. Names are kept (made safe and unique) so the folder stays readable. */
  private async storeSketches(files: File[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) {
      const clean = (f.name || 'pasted.png').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
      const dot = clean.lastIndexOf('.'), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '.png';
      let name = clean;
      for (let i = 2; this.ctx.project.assets.has(`sketches/${name}`); i++) name = `${stem}-${i}${ext}`;
      this.ctx.project.assets.set(`sketches/${name}`, new Uint8Array(await f.arrayBuffer()));
      out.push(name);
    }
    return out;
  }
  private imagesIn(list: FileList | File[] | null | undefined) {
    return [...(list ?? [])].filter((f) => IMAGE.test(f.type) || IMAGE_NAME.test(f.name)).sort((a, b) => byFileName(a.name, b.name));
  }

  /**
   * Sketch files: one file onto a panel replaces its sketch; otherwise one new panel per file, in filename order,
   * after `after` (or at the end).
   */
  async addSketches(files: File[], target: Panel | null, replace: boolean, animate: boolean) {
    if (!files.length) return;
    const before = this.snapshot(), rects = animate ? this.rects() : null;
    const names = await this.storeSketches(files);
    const made: Panel[] = [];
    if (replace && target) {
      target.sketch = names.shift();
    }
    for (const name of names) made.push(newPanel(uid(), { sketch: name }));
    const at = target ? this.index(target.id) + 1 : this.sb.panels.length;
    this.sb.panels.splice(at, 0, ...made);
    if (made.length) this.selected = made[made.length - 1].id;
    this.undoStack.push(before);
    this.redoStack = [];
    this.ctx.onChanged();
    this.render();
    if (rects) this.flip(rects);
    if (made.length > 1) this.toast(`Added ${made.length} panels from sketches.`, false);
  }

  addPanel(at: number, animate = true) {
    const p = newPanel(uid());
    this.change(() => { this.sb.panels.splice(at, 0, p); this.selected = p.id; }, animate);
    return p;
  }
  duplicate(id: string, animate: boolean) {
    const i = this.index(id);
    if (i < 0) return;
    const src = this.sb.panels[i];
    // The copy keeps the sketch, notes, length and acted poses, ready to change.
    const copy = newPanel(uid(), JSON.parse(JSON.stringify({ sketch: src.sketch, notes: src.notes, duration: panelSeconds(src, this.ctx.project.shots), cast: src.cast, lanes: src.lanes, images: src.images, stack: src.stack, camera: src.camera, rigs: src.rigs })));
    this.change(() => { this.sb.panels.splice(i + 1, 0, copy); this.selected = copy.id; }, animate);
  }
  remove(id: string, animate: boolean) {
    const i = this.index(id);
    if (i < 0) return;
    const p = this.sb.panels[i];
    this.change(() => {
      this.sb.panels.splice(i, 1);
      dropOrphanClips(this.sb); // its sound goes too
      // Its shot goes with it (undo brings both back).
      if (p.shot && !this.sb.panels.some((q) => q.shot === p.shot)) this.ctx.project.shots = this.ctx.project.shots.filter((s) => s.name !== p.shot);
      this.selected = this.sb.panels[Math.min(i, this.sb.panels.length - 1)]?.id ?? null;
    }, animate);
    this.toast(`Panel ${i + 1} deleted.`, true, !animate);
  }

  /** A short message at the bottom, with Undo where it helps. */
  toast(text: string, withUndo: boolean, fromKeyboard = false) {
    clearTimeout(this.toastTimer);
    this.toastEl.replaceChildren(h('span', {}, text));
    if (withUndo) this.toastEl.append(h('button', { class: 'link', id: 'toast-undo', onclick: () => { this.undo(); this.hideToast(); } }, 'Undo'));
    const wasHidden = this.toastEl.hidden;
    this.toastEl.hidden = false;
    if (wasHidden && !fromKeyboard) enter(this.toastEl, 'translate(-50%, 8px)', 200);
    this.toastTimer = window.setTimeout(() => this.hideToast(), 6000);
  }
  private hideToast() { this.toastEl.hidden = true; clearTimeout(this.toastTimer); }

  // --- drawing -----------------------------------------------------------------------
  render() {
    this.renderTop();
    const { panels } = this.sb;
    if (!panels.length) {
      this.grid.replaceChildren(h('div', { class: 'sb-empty' },
        h('p', {}, 'This scene has no panels yet.'),
        h('div', { class: 'row' },
          h('button', { class: 'primary', id: 'sb-first', onclick: () => this.addPanel(0) }, 'Add a panel'),
          h('button', { class: 'link', id: 'sb-import', onclick: () => this.ctx.characters() }, 'Characters')),
        h('p', { class: 'meta' }, 'Or drop sketch files here: one panel per file, in filename order.')));
      return;
    }
    this.grid.replaceChildren(...panels.map((p, i) => this.renderPanel(p, i)),
      h('button', { class: 'sb-add', id: 'sb-add', onclick: () => this.addPanel(panels.length) }, h('span', { 'aria-hidden': 'true' }, '+'), 'Add panel'));
    this.markSelection();
  }

  /** Show which panel is selected without redrawing, so a double-click still lands on the same panel. */
  private markSelection() {
    this.grid.querySelectorAll('.sb-actions').forEach((n) => n.remove());
    for (const el of this.grid.querySelectorAll<HTMLElement>('.sb-panel')) {
      const on = el.dataset.id === this.selected;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
      const p = on ? this.panel(el.dataset.id!) : null;
      if (p) {
        el.querySelector('.sb-pic')!.append(h('div', { class: 'sb-actions' },
          h('button', { class: 'sb-open', id: 'sb-open', onclick: (e: Event) => { e.stopPropagation(); this.ctx.openPanel(p); } },
            'Open scene')));
      }
    }
  }
  private select(id: string | null) { this.selected = id; this.markSelection(); }

  private renderTop() {
    const { project } = this.ctx;
    const hasSample = this.sb.panels.some((p) => p.sample);
    const anyAnimatedSketch = this.sb.panels.some((p) => this.animated(p) && p.sketch);
    this.top.replaceChildren(...[
      h('input', {
        class: 'sb-name', id: 'scene-name', 'aria-label': 'Scene name', value: this.sb.name, spellcheck: false,
        onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim() || 'Untitled scene'; this.change(() => { this.sb.name = v; }); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } },
      }),
      h('span', { class: 'sb-summary', id: 'sb-summary' }, summary(this.sb, project.shots)),
      h('span', { class: 'grow' }),
      anyAnimatedSketch ? h('label', { class: 'check' }, h('input', {
        type: 'checkbox', id: 'show-sketches', checked: !!this.sb.showSketches,
        onchange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; this.change(() => { this.sb.showSketches = v; }); },
      }), 'Show sketches') : null,
      hasSample ? h('button', { id: 'clear-sample', onclick: () => {
        this.change(() => { clearSample(project); this.selected = null; }, true);
        this.toast('Sample cleared.', true);
      } }, 'Clear sample') : null,
      this.sizeMenu(),
      h('button', { id: 'sb-characters', onclick: () => this.ctx.characters() }, 'Cast'),
      h('button', { id: 'sb-export', disabled: !this.sb.panels.length, onclick: () => openExport(project) }, 'Export video'),
      h('span', { class: 'save-state', id: 'save-state', role: 'status' }, this.ctx.saveState()),
      h('details', { class: 'menu' },
        h('summary', {}, 'Project'),
        h('div', { class: 'menu-items' },
          h('p', { class: 'meta save-status' }, this.ctx.status()),
          this.ctx.menu().map((m) => h('button', { onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); m.run(); } }, m.label)))),
    ].filter((n): n is HTMLElement => !!n));
  }

  /** The project's shape: every scene exports at this size. */
  private sizeMenu(): HTMLElement {
    const cur = sizeOf(this.sb);
    const icon = (w: number, hh: number) => h('span', { class: 'size-icon', style: `width:${Math.round((w / Math.max(w, hh)) * 16)}px;height:${Math.round((hh / Math.max(w, hh)) * 16)}px` });
    return h('details', { class: 'menu size-menu', id: 'size-menu' },
      h('summary', {}, icon(cur.w, cur.h), h('span', { class: 'px' }, `${sizeLabel(cur)} ${cur.w}×${cur.h}`)),
      h('div', { class: 'menu-items' },
        h('p', { class: 'meta save-status px' }, 'Project size · every scene exports at this size'),
        SIZES.map((o) => h('button', {
          class: 'size-opt' + (o.id === cur.id ? ' selected' : ''), 'data-size': o.id,
          onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); this.setSize({ id: o.id, w: o.w, h: o.h }); },
        }, icon(o.w, o.h), h('span', {}, o.label), h('span', { class: 'px muted' }, `${o.w}×${o.h}`))),
        h('button', { class: 'size-opt', 'data-size': 'custom', onclick: (e: Event) => {
          (e.target as HTMLElement).closest('details')!.removeAttribute('open');
          const v = prompt('Width × height in pixels, for example 1440×1080', `${cur.w}x${cur.h}`);
          const m = v && /^\s*(\d{2,5})\s*[x×*, ]\s*(\d{2,5})\s*$/.exec(v);
          if (m) this.setSize({ id: 'custom', w: Math.min(4096, +m[1]), h: Math.min(4096, +m[2]) });
        } }, icon(4, 3), h('span', {}, 'Custom…'))));
  }
  private setSize(next: ProjectSize) {
    const cur = sizeOf(this.sb);
    if (next.w === cur.w && next.h === cur.h) return;
    this.change(() => {
      for (const p of this.sb.panels) resizeCamera(p, cur, next);
      this.sb.size = next;
    });
    pictures.forget('');
  }

  private renderPanel(p: Panel, i: number): HTMLElement {
    const { project } = this.ctx;
    const secs = panelSeconds(p, project.shots);
    const el = h('article', {
      class: 'sb-panel', 'data-id': p.id, role: 'listitem', tabindex: 0,
      'aria-label': `Panel ${i + 1}, ${secs} seconds${this.animated(p) ? ', animated' : ''}`,
    });

    // Duration: typed in, shown next to the panel number.
    // An acted panel is as long as its poses; a sketch has a typed length.
    const dur = this.animated(p) ? h('span', { class: 'sb-dur fixed', title: 'Set by the poses' }, `${secs}s`)
      : this.editing?.id === p.id && this.editing.field === 'duration'
      ? h('input', {
          type: 'number', class: 'sb-dur-input', min: 0.25, step: 0.1, value: secs, 'aria-label': `Panel ${i + 1} length in seconds`,
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { e.preventDefault(); this.editing = null; this.render(); }
          },
          onblur: (e: Event) => {
            if (!this.editing) return;
            this.editing = null;
            const v = parseFloat((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v !== secs) this.change(() => setPanelSeconds(p, v, project.shots)); else this.render();
          },
        })
      : h('button', { class: 'sb-dur', title: 'Change the length', onclick: (e: Event) => { e.stopPropagation(); this.selected = p.id; this.editing = { id: p.id, field: 'duration' }; this.render(); } }, `${secs}s`);
    const head = h('div', { class: 'sb-head' }, h('span', { class: 'sb-num' }, `#${i + 1}`), h('span', { class: 'sb-dot', 'aria-hidden': 'true' }, '·'), dur,
      this.animated(p) ? h('span', { class: 'sb-badge' }, 'animated') : null);
    const castNames = [...new Set((p.cast ?? []).map((c) => c.character))];
    const keys = p.camera?.length ?? 0;
    const facts = h('div', { class: 'sb-facts' },
      ...castNames.map((n) => h('span', { class: 'chip' }, n)),
      h('span', { class: 'grow' }),
      keys ? h('span', { class: 'px muted' }, `camera · ${keys} ${keys === 1 ? 'key' : 'keys'}`) : null);

    // Picture: a frame of the shot once animated (unless sketches are asked for), else the sketch.
    // Each picture is what the camera sees when the scene starts, in the project's shape.
    const size = sizeOf(this.sb);
    const pic = h('div', { class: 'sb-pic', style: `aspect-ratio:${size.w}/${size.h}` });
    const showFrame = this.animated(p) && !(this.sb.showSketches && p.sketch);
    if (showFrame) {
      const img = h('img', { alt: `Frame from panel ${i + 1}`, draggable: false });
      const shot = compileScene(`panel:${p.id}`, p, size, { t: 0, minSeconds: 0.5 }), cached = pictures.cached(shot, 0);
      if (cached) img.src = cached;
      else void pictures.picture(project, shot, 480, 0).then((url) => { img.src = url; }).catch(() => undefined);
      pic.append(img);
    } else if (p.sketch && this.sketchUrl(p.sketch)) {
      pic.append(h('img', { src: this.sketchUrl(p.sketch)!, alt: `Sketch for panel ${i + 1}`, draggable: false }));
    } else {
      const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true,
        onchange: () => { const files = this.imagesIn(input.files); input.value = ''; void this.addSketches(files, p, true, true); } });
      pic.classList.add('empty');
      pic.append(h('span', {}, 'Drop or paste a sketch'), h('button', { class: 'link', onclick: (e: Event) => { e.stopPropagation(); input.click(); } }, 'Choose image…'), input);
    }

    // Notes: one free-text field. The panel shows the first lines; click to edit and see it all.
    const notes = this.editing?.id === p.id && this.editing.field === 'notes'
      ? h('textarea', {
          class: 'sb-notes-edit', 'aria-label': `Panel ${i + 1} notes`, value: p.notes, rows: 4,
          placeholder: 'Dialogue, action, camera, sound…',
          oninput: (e: Event) => { const t = e.target as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; },
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); this.editing = null; this.render(); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
          },
          onblur: (e: Event) => {
            if (!this.editing) return;
            this.editing = null;
            const v = (e.target as HTMLTextAreaElement).value;
            if (v !== p.notes) this.change(() => { p.notes = v; }); else this.render();
          },
        })
      : h('button', { class: 'sb-notes' + (p.notes ? '' : ' placeholder'), onclick: (e: Event) => {
          e.stopPropagation(); this.selected = p.id; this.editing = { id: p.id, field: 'notes' }; this.render();
        } }, h('span', { class: 'sb-notes-text' }, p.notes || 'Add notes'));

    el.append(
      h('button', { class: 'sb-gap', title: `Add a panel before panel ${i + 1}`, 'aria-label': `Add a panel before panel ${i + 1}`,
        onclick: (e: Event) => { e.stopPropagation(); this.addPanel(i); } }, '+'),
      head, pic, notes, facts);
    if (this.editing?.id === p.id) {
      requestAnimationFrame(() => {
        const f = el.querySelector<HTMLInputElement | HTMLTextAreaElement>('.sb-notes-edit, .sb-dur-input');
        if (!f) return;
        f.focus();
        if (f instanceof HTMLTextAreaElement) { f.style.height = `${f.scrollHeight}px`; f.setSelectionRange(f.value.length, f.value.length); } else f.select();
      });
    }
    return el;
  }

  // --- input -------------------------------------------------------------------------
  private bind() {
    const grid = this.grid;
    let press: { id: string; x: number; y: number; el: HTMLElement; pointer: number } | null = null;
    let dragging = false, target: { id: string; after: boolean } | null = null, suppressClick = false;

    const clearMarks = () => grid.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    const endDrag = (commit: boolean) => {
      if (!press) return;
      const { el, id } = press;
      if (dragging) {
        el.classList.remove('lifted');
        el.style.transform = '';
        clearMarks();
        suppressClick = true;
        if (commit && target && target.id !== id) {
          const from = this.index(id);
          let to = this.index(target.id) + (target.after ? 1 : 0);
          if (from < to) to -= 1;
          if (to !== from) {
            // The lifted panel lands from where it was dropped, then the rest settle.
            this.change(() => { movePanel(this.sb, from, to); this.selected = id; }, true);
          }
        }
      }
      press = null; dragging = false; target = null;
    };

    grid.addEventListener('pointerdown', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.sb-panel');
      if (!el || e.button !== 0 || (e.target as HTMLElement).closest('input, textarea, button, a')) return;
      press = { id: el.dataset.id!, x: e.clientX, y: e.clientY, el, pointer: e.pointerId };
    });
    grid.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.pointer) return;
      const dx = e.clientX - press.x, dy = e.clientY - press.y;
      if (!dragging) {
        if (Math.hypot(dx, dy) < 6) return; // a small threshold so a click never turns into a drag
        dragging = true;
        press.el.setPointerCapture(e.pointerId);
        press.el.classList.add('lifted');
      }
      // Follow the pointer 1:1, no easing.
      press.el.style.transform = `translate(${dx}px, ${dy}px) rotate(-1deg)`;
      let best: { el: HTMLElement; d: number } | null = null;
      for (const other of grid.querySelectorAll<HTMLElement>('.sb-panel')) {
        if (other === press.el) continue;
        const r = other.getBoundingClientRect();
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (!best || d < best.d) best = { el: other, d };
      }
      clearMarks();
      if (best) {
        const r = best.el.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
        best.el.classList.add(after ? 'drop-after' : 'drop-before');
        target = { id: best.el.dataset.id!, after };
      }
    });
    grid.addEventListener('pointerup', () => endDrag(true));
    grid.addEventListener('pointercancel', () => endDrag(false));

    grid.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (this.editing || (e.target as HTMLElement).closest('button, input, textarea, a')) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('.sb-panel');
      const id = el?.dataset.id ?? null;
      if (id === this.selected) return;
      this.select(id);
      el?.focus({ preventScroll: true });
    });
    grid.addEventListener('dblclick', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.sb-panel');
      if (!el || (e.target as HTMLElement).closest('input, textarea, button')) return;
      const p = this.panel(el.dataset.id!);
      if (p) this.ctx.openPanel(p);
    });

    // Sketch files dropped from the desktop.
    grid.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      grid.classList.add('drop-over');
      grid.querySelectorAll('.file-target').forEach((n) => n.classList.remove('file-target'));
      (e.target as HTMLElement).closest('.sb-panel')?.classList.add('file-target');
    });
    grid.addEventListener('dragleave', (e) => {
      if (!grid.contains(e.relatedTarget as Node)) { grid.classList.remove('drop-over'); grid.querySelectorAll('.file-target').forEach((n) => n.classList.remove('file-target')); }
    });
    grid.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      grid.classList.remove('drop-over');
      grid.querySelectorAll('.file-target').forEach((n) => n.classList.remove('file-target'));
      const files = this.imagesIn(e.dataTransfer.files);
      if (!files.length) { this.toast('Only image files can be sketches.', false); return; }
      const onto = this.panel((e.target as HTMLElement).closest<HTMLElement>('.sb-panel')?.dataset.id ?? null);
      void this.addSketches(files, onto, !!onto && files.length === 1, true);
    });

    const typing = (el: Element | null) => !!el?.matches('input, textarea, select, [contenteditable]');
    const onKey = (e: KeyboardEvent) => {
      // Judge by where the key was pressed: a field may already be gone (Enter saves and redraws).
      if (e.defaultPrevented || typing(e.target as Element) || typing(document.activeElement)) return;
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      if (mod && key === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); this.redo(); return; }
      const sel = this.selected;
      if (mod && key === 'd' && sel) { e.preventDefault(); this.duplicate(sel, false); this.focusSelected(); return; }
      if (mod || e.altKey) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); this.remove(sel, false); this.focusSelected(); return; }
      if (e.key === 'Enter' && sel) { e.preventDefault(); const p = this.panel(sel); if (p) this.ctx.openPanel(p); return; }
      if (e.key === 'Escape' && sel && !document.querySelector('details.menu[open]')) { this.select(null); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const n = this.sb.panels.length;
        if (!n) return;
        e.preventDefault();
        const i = sel ? this.index(sel) : -1;
        const next = Math.max(0, Math.min(n - 1, i < 0 ? 0 : i + (e.key === 'ArrowRight' ? 1 : -1)));
        this.select(this.sb.panels[next].id);
        this.focusSelected();
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (typing(document.activeElement)) return;
      const files = this.imagesIn(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      const target = this.panel(this.selected);
      void this.addSketches(files, target, !!target && files.length === 1, false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    this.disposers.push(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('paste', onPaste); });
  }
  private focusSelected() {
    if (this.selected) this.grid.querySelector<HTMLElement>(`.sb-panel[data-id="${this.selected}"]`)?.focus({ preventScroll: false });
  }

  /** The save state in the top bar changed. */
  showSaveState() { const el = this.top.querySelector('#save-state'); if (el) el.textContent = this.ctx.saveState(); }

  dispose() {
    for (const d of this.disposers) d();
    for (const { url } of this.sketchUrls.values()) URL.revokeObjectURL(url);
    clearTimeout(this.toastTimer);
  }
}
