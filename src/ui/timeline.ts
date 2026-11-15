// The timeline: a bar of playback and keyframe controls, and a canvas of rows.
// Two zoom levels (\ switches):
//   This shot  — text, images and characters (front to back) with their keys, subtitles, then the scene's
//                sound lanes (Voice with the mouth rows under it, Sound effect, Music) as heard in this shot.
//   Whole scene — every shot back to back, and the sound lanes across all of them.
// Sound belongs to the scene, so it keeps playing across the cuts; animation stays inside each shot.
import { FPS, keyAt, layerSpan, stackOrder, type Actor, type Background, type Ease, type Keyframe, type MouthKey, type TextItem, type Timing } from '../model/shot';
import {
  clipStart, LANE_LABEL, LANES, panelAt, panelFrames, panelStarts, placeClip, sceneFrames, type Lane, type Panel, type SceneClip,
} from '../model/storyboard';
import { h } from './dom';
import type { Editor } from './editor';
import { addSoundFile, addStarterEffect, STARTER_EFFECTS, toggleRecording, recordingState } from './sound';

type Row =
  | { kind: 'ruler'; h: number; label: string }
  | { kind: 'shots'; h: number; label: string }
  | { kind: 'keys'; h: number; label: string; actor: Actor }
  | { kind: 'mouth'; h: number; label: string; actor: Actor }
  | { kind: 'lane'; h: number; label: string; lane: Lane }
  | { kind: 'layer'; h: number; label: string; layer: Background }
  | { kind: 'text'; h: number; label: string; item: TextItem }
  | { kind: 'subs'; h: number; label: string };
type Drag =
  | { type: 'scrub' }
  | { type: 'key'; actor: Actor; key: Keyframe; moved: boolean }
  | { type: 'mouth'; actor: Actor; key: MouthKey }
  | { type: 'clip'; clip: SceneClip; grab: number }
  | { type: 'text'; item: TextItem; grab: number; edge: 'start' | 'end' | null }
  | { type: 'layer'; layer: Background; grab: number; edge: 'start' | 'end' | null };

const GUTTER = 150;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fileLabel = (file: string) => file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');

export class Timeline {
  private bar = h('div', { class: 'tl-bar' });
  private labels = h('div', { class: 'tl-labels' });
  private canvas = h('canvas', { class: 'tl-canvas', role: 'img', 'aria-label': 'Timeline' });
  private scroller = h('div', { class: 'tl-scroll' }, this.canvas);
  rows: Row[] = [];
  /** Pixels per frame, for each zoom level. */
  ppf = 10;
  private scenePpf = 3;
  private drag: Drag | null = null;
  /** Where the playhead is while scrubbing the whole scene outside this shot (scene frames). */
  private sceneCursor: number | null = null;
  /** Whether the options menu is open: kept across redraws of the bar. */
  moreOpen = false;
  zoom: 'shot' | 'scene' = 'shot';

  constructor(private ed: Editor, host: HTMLElement) {
    host.replaceChildren(this.bar, h('div', { class: 'tl-body' }, this.labels, this.scroller));
    this.scroller.addEventListener('scroll', () => { this.labels.scrollTop = this.scroller.scrollTop; });
    this.bind();
  }

  toggleZoom() {
    this.zoom = this.zoom === 'shot' ? 'scene' : 'shot';
    this.sceneCursor = null;
    this.render();
    // Bring the current shot into view.
    requestAnimationFrame(() => { this.scroller.scrollLeft = Math.max(0, this.x(this.zoom === 'scene' ? this.ed.sceneOffset() : 0) - 40); });
  }

  // --- controls ----------------------------------------------------------------
  renderBar() {
    const { ed } = this, shot = ed.shot, actor = ed.sel(), key = actor && keyAt(actor, ed.frame);
    const num = (id: string, value: number, min: number, set: (n: number) => void, label: string) => h('input', {
      type: 'number', id, min, step: 1, value, 'aria-label': label,
      onchange: (e: Event) => { const n = Math.round(Number((e.target as HTMLInputElement).value)); if (Number.isFinite(n)) set(Math.max(min, n)); },
    });
    const scene = this.zoom === 'scene';
    const sb = ed.project.storyboard;
    // At rest the bar shows only what every pass over the shot uses. The rest is one click away.
    this.bar.replaceChildren(...[
      scene
        ? h('button', { id: 'play', title: 'Play the whole scene, every shot in turn, with its sound (Space plays this shot)', onclick: () => { ed.stop(); ed.ctx.playScene(this.sceneCursor ?? ed.sceneOffset() + ed.frame); } }, 'Play the scene')
        : h('button', { id: 'play', class: ed.playing ? 'selected' : '', title: 'Play or stop (Space)', onclick: () => ed.play() }, ed.playing ? 'Stop' : 'Play'),
      h('label', { class: 'tl-field' }, 'Frame', num('frame', ed.frame + 1, 1, (n) => ed.setFrame(n - 1), 'Current frame')),
      h('label', { class: 'tl-field' }, 'of', num('length', shot.length, 1, (n) => { shot.length = n; ed.frame = Math.min(ed.frame, n - 1); ed.evaluateAll(); ed.refresh(); }, 'Shot length in frames')),
      h('span', { class: 'meta', id: 'seconds' }, `${(shot.length / FPS).toFixed(1)} s`),
      sb ? h('button', { id: 'zoom-scene', class: scene ? 'selected' : '', 'aria-pressed': String(scene), title: 'Show the whole scene, every shot and its sound (\\). Click again for this shot.', onclick: () => this.toggleZoom() }, 'Whole scene') : null,
      h('span', { class: 'grow' }),
      scene ? null : h('button', { id: 'set-key', class: 'primary', disabled: !actor || actor.role === 'extra', title: 'Store this pose at this frame (K)', onclick: () => ed.setKeyHere() }, key ? 'Update key' : 'Set key'),
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
          h('button', { id: 'delete-key', disabled: !key, onclick: () => ed.deleteKeyHere() }, 'Delete the key on this frame'),
          h('label', { class: 'check', title: 'Save every pose on its frame. Turn off to keep only the poses you key with K.' }, h('input', { type: 'checkbox', id: 'auto-key', checked: ed.autoKey, onchange: (e: Event) => { ed.autoKey = (e.target as HTMLInputElement).checked; } }), 'Auto-record poses'),
          h('label', { class: 'check', title: 'Show the previous and next key poses faintly' }, h('input', { type: 'checkbox', id: 'onion', checked: ed.onion, onchange: (e: Event) => { ed.onion = (e.target as HTMLInputElement).checked; ed.redraw(); } }), 'Onion skin'),
          h('div', { class: 'opt' }, h('span', {}, 'Zoom'),
            h('span', {},
              h('button', { title: 'Zoom the timeline out', 'aria-label': 'Zoom timeline out', onclick: () => this.zoomBy(-1) }, '−'),
              h('button', { title: 'Zoom the timeline in', 'aria-label': 'Zoom timeline in', onclick: () => this.zoomBy(1) }, '+'))),
          h('button', { title: 'Back to the first frame', onclick: () => ed.setFrame(0) }, 'Go to the first frame'))),
    ].filter((n): n is HTMLElement => !!n));
    this.note();
  }
  private zoomBy(dir: number) {
    if (this.zoom === 'scene') this.scenePpf = Math.max(1, Math.min(12, this.scenePpf + dir));
    else this.ppf = Math.max(3, Math.min(24, this.ppf + dir * 2));
    this.render();
  }
  private get scale() { return this.zoom === 'scene' ? this.scenePpf : this.ppf; }

  /** Says when the pose on screen is not stored in the timeline. */
  private note() {
    const { ed } = this, actor = ed.sel();
    let el = this.bar.querySelector('#unsaved') as HTMLElement | null;
    const show = !!actor && ed.unsaved.has(actor.id) && this.zoom === 'shot';
    if (show && !el) { el = h('span', { id: 'unsaved', class: 'pill warn' }, 'Not keyed: press K to keep this pose'); this.bar.querySelector('#set-key')?.before(el); }
    if (!show && el) el.remove();
  }

  // --- rows ----------------------------------------------------------------------
  private sceneLanes(): boolean { return !!this.ed.project.storyboard && !!this.ed.panel_(); }

  render() {
    const { ed } = this, shot = ed.shot;
    this.renderBar();
    this.rows = [{ kind: 'ruler', h: 24, label: '' }];
    if (this.zoom === 'scene') {
      this.rows.push({ kind: 'shots', h: 34, label: 'Shots' });
      for (const lane of LANES) this.rows.push({ kind: 'lane', h: 36, label: LANE_LABEL[lane], lane });
    } else {
      // Top to bottom is front to back, like a layers list: text, then images and characters in stack order.
      for (const item of shot.texts.filter((t) => t.kind === 'text').reverse()) this.rows.push({ kind: 'text', h: 24, label: `Text: ${item.text.replace(/\s+/g, ' ')}`, item });
      for (const id of [...stackOrder(shot)].reverse()) {
        const actor = shot.actors.find((a) => a.id === id);
        if (actor) { this.rows.push({ kind: 'keys', h: 24, label: actor.character + (actor.role === 'extra' ? ' (extra)' : ''), actor }); continue; }
        const layer = shot.backgrounds.find((b) => b.id === id);
        if (layer) this.rows.push({ kind: 'layer', h: 24, label: fileLabel(layer.file), layer });
      }
      if (shot.texts.some((t) => t.kind === 'subtitle')) this.rows.push({ kind: 'subs', h: 24, label: 'Subtitles' });
      if (this.sceneLanes()) {
        // The scene's sound as heard in this shot. Mouth rows sit under Voice.
        const clips = ed.clips();
        const speaking = new Set(clips.filter((c) => c.scene.lane === 'voice' && c.scene.speaker).map((c) => c.scene.speaker!));
        this.rows.push({ kind: 'lane', h: 36, label: LANE_LABEL.voice, lane: 'voice' });
        for (const actor of shot.actors) {
          if (actor.role === 'actor' && (actor.mouth.length || speaking.has(actor.character))) this.rows.push({ kind: 'mouth', h: 20, label: `${actor.character} mouth`, actor });
        }
        this.rows.push({ kind: 'lane', h: 36, label: LANE_LABEL.sfx, lane: 'sfx' }, { kind: 'lane', h: 36, label: LANE_LABEL.music, lane: 'music' });
      }
    }

    this.labels.replaceChildren(...this.rows.map((r) => {
      const selected = (r.kind === 'keys' && r.actor.id === ed.selId && ed.focus === 'actor') || (r.kind === 'layer' && r.layer.id === ed.selBg) || (r.kind === 'text' && r.item.id === ed.selText);
      const el = h('div', {
        class: 'tl-label' + (selected ? ' selected' : '') + (r.kind === 'mouth' ? ' sub' : '') + (r.kind === 'lane' ? ' lane' : ''),
        style: `height:${r.h}px`, title: r.label, 'data-row': r.kind === 'lane' ? r.lane : r.kind,
        onclick: () => {
          if (r.kind === 'keys' || r.kind === 'mouth') ed.select('actor', r.actor.id);
          else if (r.kind === 'layer') ed.select('layer', r.layer.id);
          else if (r.kind === 'text') ed.select('text', r.item.id);
          else return;
          ed.evaluateAll(); ed.refresh();
        },
      }, h('span', { class: 'tl-label-text' }, r.label));
      if (r.kind === 'lane') el.append(this.laneActions(r.lane));
      return el;
    }));
    this.draw();
  }

  /** "+ Add" on every lane, and Record on Voice. */
  private laneActions(lane: Lane): HTMLElement {
    const { ed } = this;
    const rec = recordingState();
    const add = lane === 'sfx'
      ? h('details', {
          class: 'menu up lane-add', id: `add-${lane}`,
          // The timeline clips its contents, so the menu is placed against the window, above its button.
          ontoggle: (e: Event) => {
            const d = e.target as HTMLDetailsElement, items = d.querySelector<HTMLElement>('.menu-items')!, r = d.querySelector('summary')!.getBoundingClientRect();
            if (d.open) Object.assign(items.style, { position: 'fixed', left: `${r.left}px`, top: 'auto', bottom: `${window.innerHeight - r.top + 4}px`, right: 'auto' });
          },
        },
          h('summary', { title: 'Add a sound effect at the playhead' }, '+ Add'),
          h('div', { class: 'menu-items' },
            STARTER_EFFECTS.map((fx) => h('button', { 'data-effect': fx.id, onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); void addStarterEffect(ed, fx.id); } }, fx.label)),
            h('hr', {}),
            h('button', { id: 'add-sfx-file', onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); addSoundFile(ed, 'sfx'); } }, 'From a file…')))
      : h('button', { class: 'lane-btn', id: `add-${lane}`, title: `Add ${lane === 'voice' ? 'a voice line' : 'music'} from a file, at the playhead`, onclick: (e: Event) => { e.stopPropagation(); addSoundFile(ed, lane); } }, '+ Add');
    return h('span', { class: 'lane-actions' }, add,
      lane === 'voice' ? h('button', {
        class: 'lane-btn' + (rec.active ? ' recording' : ''), id: 'record-take',
        title: 'Record a scratch take for this shot. It starts at the beginning of the shot and sets the shot\'s length.',
        onclick: (e: Event) => { e.stopPropagation(); void toggleRecording(ed); },
      }, rec.active ? `Stop ${rec.seconds.toFixed(1)}s` : 'Record') : null);
  }

  private size() {
    const { ed } = this;
    const frames = this.zoom === 'scene' ? sceneFrames(ed.project.storyboard!, ed.project.shots) : ed.shot.length;
    const w = Math.max(this.scroller.clientWidth, frames * this.scale + 80), hgt = this.rows.reduce((s, r) => s + r.h, 0);
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(hgt * dpr)) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(hgt * dpr);
      this.canvas.style.width = `${w}px`; this.canvas.style.height = `${hgt}px`;
    }
    return { w, h: hgt, dpr, frames };
  }
  private x = (frame: number) => frame * this.scale;

  draw() {
    const { ed } = this, shot = ed.shot, ppf = this.scale, scene = this.zoom === 'scene';
    const sb = ed.project.storyboard;
    const { w, h: height, dpr, frames } = this.size();
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ink = css('--ink'), muted = css('--muted'), line = css('--line'), accent = css('--accent'), surface = css('--surface'), bg = css('--bg');
    g.fillStyle = surface; g.fillRect(0, 0, w, height);
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
    const offset = scene ? ed.sceneOffset() : 0; // frames of the shot are drawn from here
    const starts = sb ? panelStarts(sb, ed.project.shots) : new Map<string, number>();
    const clipsBase = scene ? 0 : ed.sceneOffset(); // scene frame at x = 0

    let y = 0;
    for (const row of this.rows) {
      const mid = y + row.h / 2;
      if (row.kind === 'keys' && row.actor.id === ed.selId) { g.fillStyle = css('--accent-soft'); g.fillRect(0, y, w, row.h); }
      else if (row.kind !== 'ruler' && row.kind !== 'mouth' && row.kind !== 'keys') { g.fillStyle = bg; g.fillRect(0, y, w, row.h); }
      g.strokeStyle = line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y + row.h + 0.5); g.lineTo(w, y + row.h + 0.5); g.stroke();

      if (row.kind === 'ruler') {
        const every = scene ? (ppf < 3 ? 48 : 24) : 12;
        for (let f = 0; f <= frames; f++) {
          const major = f % every === 0;
          if (!major && (ppf < 6 || scene)) continue;
          g.strokeStyle = major ? muted : line; g.beginPath(); g.moveTo(this.x(f) + 0.5, major ? 4 : 16); g.lineTo(this.x(f) + 0.5, row.h); g.stroke();
          if (major && f < frames) { g.fillStyle = muted; g.fillText(scene ? `${Math.floor(f / FPS / 60)}:${String(Math.floor(f / FPS) % 60).padStart(2, '0')}` : f % 24 === 0 ? `${f + 1} · ${f / 24}s` : String(f + 1), this.x(f) + 4, 9); }
        }
      } else if (row.kind === 'shots' && sb) {
        sb.panels.forEach((p, i) => {
          const x0 = this.x(starts.get(p.id) ?? 0), wide = panelFrames(p, ed.project.shots) * ppf, here = p.shot === shot.name;
          g.fillStyle = here ? accent : p.shot ? ink : muted;
          g.fillRect(x0 + 1, y + 4, Math.max(2, wide - 2), row.h - 8);
          g.save(); g.beginPath(); g.rect(x0, y, wide - 4, row.h); g.clip();
          g.fillStyle = surface; g.fillText(`${i + 1}${p.notes ? ` · ${p.notes.split('\n')[0]}` : ''}`, x0 + 6, mid); g.restore();
        });
      } else if (row.kind === 'keys') {
        for (const k of row.actor.keys) {
          const cx = this.x(k.frame) + ppf / 2, here = k.frame === ed.frame && row.actor.id === ed.selId;
          g.fillStyle = here ? accent : ink;
          g.beginPath();
          if (k.ease === 'hold') g.rect(cx - 4.5, mid - 4.5, 9, 9); // a held key is a square
          else { g.moveTo(cx, mid - 6); g.lineTo(cx + 6, mid); g.lineTo(cx, mid + 6); g.lineTo(cx - 6, mid); g.closePath(); }
          g.fill();
        }
        if (!row.actor.keys.length && row.actor.role === 'actor') { g.fillStyle = muted; g.fillText('No keys yet: pose it on two frames, then press Space', 8, mid); }
      } else if (row.kind === 'mouth') {
        for (const m of row.actor.mouth) {
          g.fillStyle = muted; g.fillRect(this.x(m.frame) + 1, y + 3, Math.max(2, ppf - 2), row.h - 6);
          if (ppf >= 8) { g.fillStyle = surface; g.fillText(m.shape.slice(0, 2), this.x(m.frame) + 2, mid); }
        }
      } else if (row.kind === 'lane' && sb) {
        for (const clip of sb.sound ?? []) {
          if (clip.lane !== row.lane) continue;
          const at = clipStart(sb, ed.project.shots, clip, starts);
          if (at === null) continue;
          const vol = ed.audio.volume(clip.file), len = Math.max(vol.length, 1), x0 = this.x(at - clipsBase), wide = Math.max(4, len * ppf);
          if (x0 + wide < 0 || x0 > w) continue;
          const on = clip.id === ed.selClip;
          g.fillStyle = surface; g.fillRect(x0, y + 2, wide, row.h - 4);
          g.strokeStyle = on ? accent : muted; g.lineWidth = on ? 2 : 1; g.strokeRect(x0 + 0.5, y + 2.5, wide - 1, row.h - 5); g.lineWidth = 1;
          let peak = 0.0001;
          for (let i = 0; i < vol.length; i++) peak = Math.max(peak, vol[i]);
          g.fillStyle = row.lane === 'voice' ? ink : muted;
          const step = Math.max(1, Math.round(2 / ppf));
          for (let i = 0; i < vol.length; i += step) {
            const bar = Math.max(1, (vol[i] / peak) * (row.h - 14));
            g.fillRect(x0 + i * ppf + 0.5, mid + 2 - bar / 2, Math.max(1, ppf * step - 1), bar);
          }
          // The name sits on a small tab of its own, so the waveform never hides it.
          const label = `${fileLabel(clip.file)}${clip.speaker ? ` · ${clip.speaker}` : ''}`;
          g.save(); g.beginPath(); g.rect(x0, y, wide - 2, row.h); g.clip();
          g.font = '600 10px system-ui, sans-serif';
          g.fillStyle = surface; g.fillRect(x0 + 1, y + 3, g.measureText(label).width + 8, 12);
          g.fillStyle = on ? accent : ink;
          g.fillText(label, x0 + 5, y + 9); g.restore();
          g.font = '11px system-ui, sans-serif';
        }
        // Cuts between shots, so it is clear a sound plays across them.
        if (!scene) {
          g.strokeStyle = accent; g.setLineDash([3, 3]);
          for (const x of [this.x(0), this.x(shot.length)]) { g.beginPath(); g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, y + row.h); g.stroke(); }
          g.setLineDash([]);
        }
      } else if (row.kind === 'layer' || row.kind === 'text' || row.kind === 'subs') {
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
    if (scene) {
      // This shot, marked on the whole scene.
      g.fillStyle = 'rgba(199, 66, 31, 0.07)'; g.fillRect(this.x(offset), 0, shot.length * ppf, height);
    } else {
      // Past the end of the shot.
      g.fillStyle = 'rgba(31, 36, 48, 0.12)'; g.fillRect(this.x(shot.length), 0, w - this.x(shot.length), height);
    }
    // Playhead.
    const head = scene ? (this.sceneCursor ?? offset + ed.frame) : ed.frame;
    g.fillStyle = 'rgba(199, 66, 31, 0.16)'; g.fillRect(this.x(head), 0, Math.max(2, ppf), height);
    g.fillStyle = accent; g.fillRect(this.x(head) + Math.max(2, ppf) / 2 - 1, 0, 2, height);

    const input = this.bar.querySelector('#frame') as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = String(ed.frame + 1);
    this.note();
  }

  // --- pointer -------------------------------------------------------------------
  private at(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    let y = 0, row: Row | null = null;
    for (const candidate of this.rows) { if (py >= y && py < y + candidate.h) { row = candidate; break; } y += candidate.h; }
    return { px, frame: Math.floor(px / this.scale), row };
  }
  /** A clip under a timeline frame on a lane. Frames are this zoom's own. */
  private clipAt(lane: Lane, frame: number): SceneClip | null {
    const sb = this.ed.project.storyboard;
    if (!sb) return null;
    const base = this.zoom === 'scene' ? 0 : this.ed.sceneOffset();
    const hits = (sb.sound ?? []).filter((c) => {
      if (c.lane !== lane) return false;
      const at = clipStart(sb, this.ed.project.shots, c);
      if (at === null) return false;
      const len = Math.max(1, this.ed.audio.frames(c.file));
      return frame + base >= at && frame + base < at + len;
    });
    return hits[hits.length - 1] ?? null;
  }
  /** In the whole-scene view: go to a scene frame, opening its shot if it is another one. */
  private goToSceneFrame(frame: number, release: boolean) {
    const { ed } = this, sb = ed.project.storyboard!;
    const hit = panelAt(sb, ed.project.shots, Math.max(0, frame));
    if (!hit) return;
    if (hit.panel.shot === ed.shot.name) { this.sceneCursor = null; ed.setFrame(frame - hit.start, { scrub: !release, keep: true }); return; }
    this.sceneCursor = frame;
    if (release) { this.sceneCursor = null; ed.ctx.openPanel(hit.panel as Panel, frame - hit.start); return; }
    this.draw();
  }

  private bind() {
    const { canvas, ed } = this;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const { px, frame, row } = this.at(e), shot = ed.shot, scene = this.zoom === 'scene', ppf = this.scale;
      canvas.setPointerCapture(e.pointerId);
      if (ed.playing) ed.stop();
      const near = (f: number) => Math.abs(px - (this.x(f) + ppf / 2)) <= Math.max(6, ppf / 2);
      this.drag = { type: 'scrub' };
      if (row?.kind === 'lane') {
        const clip = this.clipAt(row.lane, frame);
        if (clip) {
          const base = scene ? 0 : ed.sceneOffset();
          ed.select('clip', clip.id);
          this.drag = { type: 'clip', clip, grab: frame + base - (clipStart(ed.project.storyboard!, ed.project.shots, clip) ?? 0) };
          ed.refresh();
          return;
        }
      } else if (scene && row?.kind === 'shots') {
        const hit = panelAt(ed.project.storyboard!, ed.project.shots, frame);
        if (hit && hit.panel.shot !== shot.name) { ed.ctx.openPanel(hit.panel, 0); this.drag = null; return; }
      } else if (row?.kind === 'keys') {
        ed.select('actor', row.actor.id);
        const key = row.actor.keys.find((k) => near(k.frame));
        if (key) { this.drag = { type: 'key', actor: row.actor, key, moved: false }; ed.setFrame(key.frame, { keep: true }); ed.refresh(); return; }
      } else if (row?.kind === 'mouth') {
        ed.selId = row.actor.id;
        const key = row.actor.mouth.find((m) => near(m.frame));
        if (key) this.drag = { type: 'mouth', actor: row.actor, key };
      } else if (row?.kind === 'subs' || row?.kind === 'text') {
        const item = row.kind === 'text' ? (frame >= row.item.start && frame < row.item.end ? row.item : undefined)
          : shot.texts.filter((t) => t.kind === 'subtitle').reverse().find((t) => frame >= t.start && frame < t.end);
        if (item) {
          const edge = px - this.x(item.start) < 6 ? 'start' : this.x(item.end) - px < 6 ? 'end' : null;
          ed.select('text', item.id);
          this.drag = { type: 'text', item, grab: frame - item.start, edge };
        }
      } else if (row?.kind === 'layer') {
        const [start, end] = layerSpan(row.layer, shot);
        ed.select('layer', row.layer.id);
        if (frame >= start && frame < end) {
          const edge = px - this.x(start) < 6 ? 'start' : this.x(end) - px < 6 ? 'end' : null;
          this.drag = { type: 'layer', layer: row.layer, grab: frame - start, edge };
        } else { ed.setFrame(frame, { keep: true }); ed.refresh(); this.drag = { type: 'scrub' }; return; }
      }
      if (this.drag.type === 'scrub') {
        if (scene) this.goToSceneFrame(frame, false);
        else ed.setFrame(frame, { scrub: true, keep: true });
      } else ed.refresh();
    });
    canvas.addEventListener('pointermove', (e) => {
      const drag = this.drag;
      if (!drag) return;
      const frame = Math.max(0, this.at(e).frame), scene = this.zoom === 'scene';
      if (drag.type === 'scrub') {
        if (scene) { this.goToSceneFrame(frame, false); ed.audio.scrub(ed.clips(), frame - ed.sceneOffset()); return; }
        return ed.setFrame(frame, { scrub: true });
      }
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
      } else if (drag.type === 'clip') {
        // Pinned again to whichever shot it now starts in.
        const base = scene ? 0 : ed.sceneOffset();
        placeClip(ed.project.storyboard!, ed.project.shots, drag.clip, frame + base - drag.grab);
      } else if (drag.type === 'layer') {
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
    const end = (e: PointerEvent) => {
      if (!this.drag) return;
      const wasScrub = this.drag.type === 'scrub';
      this.drag = null;
      ed.audio.stop();
      if (wasScrub && this.zoom === 'scene' && this.sceneCursor !== null) { this.goToSceneFrame(Math.max(0, this.at(e).frame), true); return; }
      if (!wasScrub) ed.evaluateAll();
      ed.refresh();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }
}

export { GUTTER };
