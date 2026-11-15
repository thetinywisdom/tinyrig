// The timeline: a bar of playback and keyframe controls, and a canvas with one
// row per character (keys), mouth keys, sound clips with their waveforms, and text.
import { FPS, keyAt, layerSpan, type Actor, type AudioClip, type Background, type Ease, type Keyframe, type MouthKey, type TextItem, type Timing } from '../model/shot';
import { h } from './dom';
import type { Editor } from './editor';

type Row =
  | { kind: 'ruler'; h: number; label: string }
  | { kind: 'keys'; h: number; label: string; actor: Actor }
  | { kind: 'mouth'; h: number; label: string; actor: Actor }
  | { kind: 'audio'; h: number; label: string; clip: AudioClip }
  | { kind: 'layer'; h: number; label: string; layer: Background }
  | { kind: 'text'; h: number; label: string; item: TextItem }
  | { kind: 'subs'; h: number; label: string };
type Drag =
  | { type: 'scrub' }
  | { type: 'key'; actor: Actor; key: Keyframe; moved: boolean }
  | { type: 'mouth'; actor: Actor; key: MouthKey }
  | { type: 'clip'; clip: AudioClip; grab: number }
  | { type: 'text'; item: TextItem; grab: number; edge: 'start' | 'end' | null }
  | { type: 'layer'; layer: Background; grab: number; edge: 'start' | 'end' | null };

const GUTTER = 150;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class Timeline {
  private bar = h('div', { class: 'tl-bar' });
  private labels = h('div', { class: 'tl-labels' });
  private canvas = h('canvas', { class: 'tl-canvas', role: 'img', 'aria-label': 'Timeline' });
  private scroller = h('div', { class: 'tl-scroll' }, this.canvas);
  private rows: Row[] = [];
  private ppf = 10; // pixels per frame
  private drag: Drag | null = null;
  /** Whether the options menu is open: kept across redraws of the bar. */
  moreOpen = false;

  constructor(private ed: Editor, host: HTMLElement) {
    host.replaceChildren(this.bar, h('div', { class: 'tl-body' }, this.labels, this.scroller));
    this.scroller.addEventListener('scroll', () => { this.labels.scrollTop = this.scroller.scrollTop; });
    this.bind();
  }

  // --- controls ----------------------------------------------------------------
  renderBar() {
    const { ed } = this, shot = ed.shot, actor = ed.sel(), key = actor && keyAt(actor, ed.frame);
    const num = (id: string, value: number, min: number, set: (n: number) => void, label: string) => h('input', {
      type: 'number', id, min, step: 1, value, 'aria-label': label,
      onchange: (e: Event) => { const n = Math.round(Number((e.target as HTMLInputElement).value)); if (Number.isFinite(n)) set(Math.max(min, n)); },
    });
    // At rest the bar shows only what every pass over the shot uses. The rest is one click away.
    this.bar.replaceChildren(
      h('button', { id: 'play', class: ed.playing ? 'selected' : '', title: 'Play or stop (Space)', onclick: () => ed.play() }, ed.playing ? 'Stop' : 'Play'),
      h('label', { class: 'tl-field' }, 'Frame', num('frame', ed.frame + 1, 1, (n) => ed.setFrame(n - 1), 'Current frame')),
      h('label', { class: 'tl-field' }, 'of', num('length', shot.length, 1, (n) => { shot.length = n; ed.frame = Math.min(ed.frame, n - 1); ed.evaluateAll(); ed.refresh(); }, 'Shot length in frames')),
      h('span', { class: 'meta', id: 'seconds' }, `${(shot.length / FPS).toFixed(1)} s`),
      h('span', { class: 'grow' }),
      h('details', { class: 'menu up', id: 'add-layer' },
        h('summary', {}, 'Add layer'),
        h('div', { class: 'menu-items' }, ([
          ['layer-image-back', 'Image behind the characters…', () => ed.addImageLayer(false)],
          ['layer-image-front', 'Image in front of the characters…', () => ed.addImageLayer(true)],
          ['layer-text', 'Text', () => ed.addTextLayer()],
        ] as [string, string, () => void][]).map(([id, text, run]) => h('button', { id, onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); run(); } }, text)))),
      h('button', { id: 'set-key', class: 'primary', disabled: !actor || actor.role === 'extra', title: 'Store this pose at this frame (K)', onclick: () => ed.setKeyHere() }, key ? 'Update key' : 'Set key'),
      h('button', { id: 'delete-key', disabled: !key, onclick: () => ed.deleteKeyHere() }, 'Delete key'),
      h('details', { class: 'menu up tl-more', open: this.moreOpen || this.ed.openAll, ontoggle: (e: Event) => { this.moreOpen = (e.target as HTMLDetailsElement).open; } },
        h('summary', {}, 'Timeline options'),
        h('div', { class: 'menu-items' },
          h('div', { class: 'opt' }, h('span', {}, 'Timing for the shot'),
            h('div', { class: 'seg', role: 'group', 'aria-label': 'Timing for the whole shot' }, ([1, 2, 3] as Timing[]).map((t) => h('button', {
              class: shot.timing === t ? 'selected' : '', 'data-timing': t,
              title: t === 1 ? 'On ones: a new drawing every frame' : t === 2 ? 'On twos: each drawing held for 2 frames' : 'On threes: each drawing held for 3 frames',
              onclick: () => { shot.timing = t; ed.evaluateAll(); ed.refresh(); },
            }, `${t}s`)))),
          h('label', { class: 'opt' }, h('span', {}, 'After this key'),
            h('select', { id: 'ease', disabled: !key, title: 'How the character moves from this key to the next', onchange: (e: Event) => { if (key) { key.ease = (e.target as HTMLSelectElement).value as Ease; ed.evaluateAll(); ed.refresh(); } } },
              ([['ease', 'Ease'], ['linear', 'Even'], ['hold', 'Hold']] as [Ease, string][]).map(([v, text]) => h('option', { value: v, selected: key?.ease === v }, text)))),
          h('label', { class: 'check', title: 'Save every pose on its frame. Turn off to keep only the poses you key with K.' }, h('input', { type: 'checkbox', id: 'auto-key', checked: ed.autoKey, onchange: (e: Event) => { ed.autoKey = (e.target as HTMLInputElement).checked; } }), 'Auto-record poses'),
          h('label', { class: 'check', title: 'Show the previous and next key poses faintly' }, h('input', { type: 'checkbox', id: 'onion', checked: ed.onion, onchange: (e: Event) => { ed.onion = (e.target as HTMLInputElement).checked; ed.redraw(); } }), 'Onion skin'),
          h('div', { class: 'opt' }, h('span', {}, 'Zoom'),
            h('span', {},
              h('button', { title: 'Zoom the timeline out', 'aria-label': 'Zoom timeline out', onclick: () => { this.ppf = Math.max(3, this.ppf - 2); this.render(); } }, '−'),
              h('button', { title: 'Zoom the timeline in', 'aria-label': 'Zoom timeline in', onclick: () => { this.ppf = Math.min(24, this.ppf + 2); this.render(); } }, '+'))),
          h('button', { title: 'Back to the first frame', onclick: () => ed.setFrame(0) }, 'Go to the first frame'))),
    );
    this.note();
  }

  /** Says when the pose on screen is not stored in the timeline. */
  private note() {
    const { ed } = this, actor = ed.sel();
    let el = this.bar.querySelector('#unsaved') as HTMLElement | null;
    const show = !!actor && ed.unsaved.has(actor.id);
    if (show && !el) { el = h('span', { id: 'unsaved', class: 'pill warn' }, 'Not keyed: press K to keep this pose'); this.bar.querySelector('#set-key')!.before(el); }
    if (!show && el) el.remove();
  }

  // --- rows ----------------------------------------------------------------------
  render() {
    const { ed } = this, shot = ed.shot;
    this.renderBar();
    // Top to bottom is front to back, like a layers panel: text, images in front, characters, images behind, then sound.
    const layerRow = (layer: Background): Row => ({ kind: 'layer', h: 24, label: layer.file.replace(/\.[^.]+$/, ''), layer });
    this.rows = [{ kind: 'ruler', h: 24, label: '' }];
    for (const item of shot.texts.filter((t) => t.kind === 'text').reverse()) this.rows.push({ kind: 'text', h: 24, label: `Text: ${item.text.replace(/\s+/g, ' ')}`, item });
    for (const layer of shot.backgrounds.filter((l) => l.front).reverse()) this.rows.push(layerRow(layer));
    for (const actor of [...shot.actors].reverse()) {
      this.rows.push({ kind: 'keys', h: 24, label: actor.character + (actor.role === 'extra' ? ' (extra)' : ''), actor });
      if (actor.mouth.length || shot.audio.some((c) => c.actor === actor.id)) this.rows.push({ kind: 'mouth', h: 20, label: 'mouth', actor });
    }
    for (const layer of shot.backgrounds.filter((l) => !l.front).reverse()) this.rows.push(layerRow(layer));
    for (const clip of shot.audio) this.rows.push({ kind: 'audio', h: 40, label: `${clip.kind === 'music' ? 'Music' : 'Dialogue'}: ${clip.file}`, clip });
    if (shot.texts.some((t) => t.kind === 'subtitle')) this.rows.push({ kind: 'subs', h: 24, label: 'Subtitles' });

    this.labels.replaceChildren(...this.rows.map((r) => h('div', {
      class: 'tl-label' + ((r.kind === 'keys' && r.actor.id === ed.selId && !ed.selBg && !ed.selText) || (r.kind === 'layer' && r.layer.id === ed.selBg) || (r.kind === 'text' && r.item.id === ed.selText) ? ' selected' : '') + (r.kind === 'mouth' ? ' sub' : ''),
      style: `height:${r.h}px`, title: r.label,
      onclick: () => {
        if (r.kind === 'keys' || r.kind === 'mouth') { ed.selId = r.actor.id; ed.selBg = ed.selText = null; } else if (r.kind === 'layer') { ed.selBg = r.layer.id; ed.selText = null; } else if (r.kind === 'text') { ed.selText = r.item.id; ed.selBg = null; } else return;
        ed.refresh();
      },
    }, r.label)));
    this.draw();
  }

  private size() {
    const w = Math.max(this.scroller.clientWidth, ed_w(this.ed.shot.length, this.ppf)), hgt = this.rows.reduce((s, r) => s + r.h, 0);
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(hgt * dpr);
      this.canvas.style.width = `${w}px`; this.canvas.style.height = `${hgt}px`;
    }
    return { w, h: hgt, dpr };
  }
  private x = (frame: number) => frame * this.ppf;

  draw() {
    const { ed, ppf } = this, shot = ed.shot;
    const { w, h: height, dpr } = this.size();
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = css('--ink'), muted = css('--muted'), line = css('--line'), accent = css('--accent'), surface = css('--surface'), bg = css('--bg');
    g.fillStyle = surface; g.fillRect(0, 0, w, height);
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';

    let y = 0;
    for (const row of this.rows) {
      const mid = y + row.h / 2;
      if (row.kind === 'keys' && row.actor.id === ed.selId) { g.fillStyle = css('--accent-soft'); g.fillRect(0, y, w, row.h); }
      else if (row.kind !== 'ruler' && row.kind !== 'mouth' && row.kind !== 'keys') { g.fillStyle = bg; g.fillRect(0, y, w, row.h); }
      g.strokeStyle = line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y + row.h + 0.5); g.lineTo(w, y + row.h + 0.5); g.stroke();

      if (row.kind === 'ruler') {
        for (let f = 0; f <= shot.length; f++) {
          const major = f % 12 === 0;
          if (!major && ppf < 6) continue;
          g.strokeStyle = major ? muted : line; g.beginPath(); g.moveTo(this.x(f) + 0.5, major ? 4 : 16); g.lineTo(this.x(f) + 0.5, row.h); g.stroke();
          if (major && f < shot.length) { g.fillStyle = muted; g.fillText(f % 24 === 0 ? `${f + 1} · ${f / 24}s` : String(f + 1), this.x(f) + 4, 9); }
        }
      } else if (row.kind === 'keys') {
        for (const k of row.actor.keys) {
          const cx = this.x(k.frame) + ppf / 2, here = k.frame === ed.frame && row.actor.id === ed.selId;
          g.fillStyle = here ? accent : ink;
          g.beginPath();
          if (k.ease === 'hold') g.rect(cx - 4.5, mid - 4.5, 9, 9); // a held key is a square
          else { g.moveTo(cx, mid - 6); g.lineTo(cx + 6, mid); g.lineTo(cx, mid + 6); g.lineTo(cx - 6, mid); g.closePath(); }
          g.fill();
        }
        if (!row.actor.keys.length && row.actor.role === 'actor') { g.fillStyle = muted; g.fillText('No keys yet: pose it, then press K', 8, mid); }
      } else if (row.kind === 'mouth') {
        for (const m of row.actor.mouth) {
          g.fillStyle = muted; g.fillRect(this.x(m.frame) + 1, y + 3, Math.max(2, ppf - 2), row.h - 6);
          if (ppf >= 8) { g.fillStyle = surface; g.fillText(m.shape.slice(0, 2), this.x(m.frame) + 2, mid); }
        }
      } else if (row.kind === 'audio') {
        const vol = ed.audio.volume(row.clip.file), x0 = this.x(row.clip.start);
        g.fillStyle = surface; g.fillRect(x0, y + 2, Math.max(4, vol.length * ppf), row.h - 4);
        g.strokeStyle = muted; g.strokeRect(x0 + 0.5, y + 2.5, Math.max(4, vol.length * ppf) - 1, row.h - 5);
        let peak = 0.0001;
        for (let i = 0; i < vol.length; i++) peak = Math.max(peak, vol[i]);
        g.fillStyle = row.clip.kind === 'music' ? muted : ink;
        for (let i = 0; i < vol.length; i++) {
          const bar = Math.max(1, (vol[i] / peak) * (row.h - 10));
          g.fillRect(x0 + i * ppf + 1, mid - bar / 2, Math.max(1, ppf - 1), bar);
        }
      } else {
        const bars: { start: number; end: number; text: string; on: boolean }[] =
          row.kind === 'layer' ? [{ start: layerSpan(row.layer, shot)[0], end: layerSpan(row.layer, shot)[1], text: row.layer.file, on: row.layer.id === ed.selBg }]
          : row.kind === 'text' ? [{ start: row.item.start, end: row.item.end, text: row.item.text, on: row.item.id === ed.selText }]
          : shot.texts.filter((x) => x.kind === 'subtitle').map((t) => ({ start: t.start, end: t.end, text: t.text, on: t.id === ed.selText }));
        for (const bar of bars) {
          const x0 = this.x(bar.start), wide = Math.max(4, (bar.end - bar.start) * ppf);
          g.fillStyle = bar.on ? accent : row.kind === 'layer' ? muted : ink; g.fillRect(x0, y + 3, wide, row.h - 6);
          g.save(); g.beginPath(); g.rect(x0, y, wide - 4, row.h); g.clip();
          g.fillStyle = surface; g.fillText(bar.text.replace(/\s+/g, ' ') || '(empty)', x0 + 5, mid); g.restore();
        }
      }
      y += row.h;
    }
    // Past the end of the shot.
    g.fillStyle = 'rgba(31, 36, 48, 0.12)'; g.fillRect(this.x(shot.length), 0, w - this.x(shot.length), height);
    // Playhead.
    g.fillStyle = 'rgba(199, 66, 31, 0.16)'; g.fillRect(this.x(ed.frame), 0, ppf, height);
    g.fillStyle = accent; g.fillRect(this.x(ed.frame) + ppf / 2 - 1, 0, 2, height);

    const input = this.bar.querySelector('#frame') as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = String(ed.frame + 1);
    this.note();
  }

  // --- pointer -------------------------------------------------------------------
  private at(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let y = 0, row: Row | null = null;
    for (const candidate of this.rows) { if (py >= y && py < y + candidate.h) { row = candidate; break; } y += candidate.h; }
    return { px, frame: Math.floor(px / this.ppf), row };
  }

  private bind() {
    const { canvas, ed } = this;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const { px, frame, row } = this.at(e), shot = ed.shot;
      canvas.setPointerCapture(e.pointerId);
      if (ed.playing) ed.stop();
      const near = (f: number) => Math.abs(px - (this.x(f) + this.ppf / 2)) <= Math.max(6, this.ppf / 2);
      this.drag = { type: 'scrub' };
      if (row?.kind === 'keys') {
        ed.selId = row.actor.id; ed.selBg = ed.selText = null;
        const key = row.actor.keys.find((k) => near(k.frame));
        if (key) { this.drag = { type: 'key', actor: row.actor, key, moved: false }; ed.setFrame(key.frame, { keep: true }); ed.refresh(); return; }
      } else if (row?.kind === 'mouth') {
        ed.selId = row.actor.id;
        const key = row.actor.mouth.find((m) => near(m.frame));
        if (key) this.drag = { type: 'mouth', actor: row.actor, key };
      } else if (row?.kind === 'audio') {
        const len = Math.max(1, ed.audio.frames(row.clip.file));
        if (frame >= row.clip.start && frame < row.clip.start + len) this.drag = { type: 'clip', clip: row.clip, grab: frame - row.clip.start };
      } else if (row?.kind === 'subs' || row?.kind === 'text') {
        const item = row.kind === 'text' ? (frame >= row.item.start && frame < row.item.end ? row.item : undefined)
          : shot.texts.filter((t) => t.kind === 'subtitle').reverse().find((t) => frame >= t.start && frame < t.end);
        if (item) {
          const edge = px - this.x(item.start) < 6 ? 'start' : this.x(item.end) - px < 6 ? 'end' : null;
          ed.selText = item.id; ed.selBg = null;
          this.drag = { type: 'text', item, grab: frame - item.start, edge };
        }
      } else if (row?.kind === 'layer') {
        const [start, end] = layerSpan(row.layer, shot);
        ed.selBg = row.layer.id; ed.selText = null;
        if (frame >= start && frame < end) {
          const edge = px - this.x(start) < 6 ? 'start' : this.x(end) - px < 6 ? 'end' : null;
          this.drag = { type: 'layer', layer: row.layer, grab: frame - start, edge };
        } else { ed.setFrame(frame, { keep: true }); ed.refresh(); this.drag = { type: 'scrub' }; return; }
      }
      if (this.drag.type === 'scrub') ed.setFrame(frame, { scrub: true, keep: true });
      else ed.refresh();
    });
    canvas.addEventListener('pointermove', (e) => {
      const drag = this.drag;
      if (!drag) return;
      const frame = Math.max(0, this.at(e).frame);
      if (drag.type === 'scrub') return ed.setFrame(frame, { scrub: true });
      if (drag.type === 'key') {
        if (frame === drag.key.frame || frame >= ed.shot.length || drag.actor.keys.some((k) => k !== drag.key && k.frame === frame)) return;
        drag.key.frame = frame; drag.moved = true;
        drag.actor.keys.sort((a, b) => a.frame - b.frame);
        ed.setFrame(frame, { keep: true });
      } else if (drag.type === 'mouth') {
        if (drag.actor.mouth.some((m) => m !== drag.key && m.frame === frame)) return;
        drag.key.frame = frame;
        drag.actor.mouth.sort((a, b) => a.frame - b.frame);
        ed.evaluateAll(); ed.redraw();
      } else if (drag.type === 'clip') drag.clip.start = Math.max(0, frame - drag.grab);
      else if (drag.type === 'layer') {
        // Dragging gives the layer its own start and end; until then it lasts the whole shot.
        const l = drag.layer, [start, end] = layerSpan(l, ed.shot), len = end - start;
        if (drag.edge === 'start') l.start = Math.min(end - 1, frame);
        else if (drag.edge === 'end') l.end = Math.max(start + 1, frame + 1);
        else { l.start = Math.max(0, frame - drag.grab); l.end = l.start + len; }
        ed.redraw();
      } else if (drag.type === 'text') {
        const t = drag.item, len = t.end - t.start;
        if (drag.edge === 'start') t.start = Math.min(t.end - 1, frame);
        else if (drag.edge === 'end') t.end = Math.max(t.start + 1, frame + 1);
        else { t.start = Math.max(0, frame - drag.grab); t.end = t.start + len; }
        ed.redraw();
      }
      this.draw();
    });
    const end = () => {
      if (!this.drag) return;
      const wasScrub = this.drag.type === 'scrub';
      this.drag = null;
      ed.audio.stop();
      if (!wasScrub) ed.evaluateAll();
      ed.refresh();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }
}

const ed_w = (length: number, ppf: number) => length * ppf + 80;
export { GUTTER };
