// A controller pad drawn over the stage: a square with nine slot marks and a
// knob (or, for a slider, a track with three). Dragging reports the knob
// position while moving and calls onEnd once on release, so one drag is one undo step.
import { SLOT_LABEL, SLOT_POS, SLOTS, type Pad } from '../model/pads';
import type { Pt } from '../model/types';

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: Node[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

function onDrag(target: Element, start: (e: PointerEvent) => boolean | void, move: (e: PointerEvent) => void, end: () => void) {
  target.addEventListener('pointerdown', (ev) => {
    const e = ev as PointerEvent;
    if (e.button !== 0 || start(e) === false) return;
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    const onMove = (m: Event) => move(m as PointerEvent);
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      end();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  });
}

export interface PadView { el: HTMLElement; set(knob: Pt): void }

export function padControl(opts: {
  pad: Pad; selected: boolean;
  onKnob: (knob: Pt) => void; onEnd: () => void;
  onSelect: () => void; onMoved: (at: Pt) => void;
}): PadView {
  const { pad } = opts;
  const slider = pad.kind === 'slider';
  const R = 48, H = slider ? 15 : R; // half extents of the knob's travel
  const slots = SLOTS.filter((s) => !slider || SLOT_POS[s][1] === 0);

  const knob = svg('rect', { class: 'knob', x: -9, y: -9, width: 18, height: 18, rx: 3 });
  const area = svg('svg', {
    class: 'pad-area', viewBox: `${-R - 12} ${-H - 12} ${2 * R + 24} ${2 * H + 24}`, width: 2 * R + 24, height: 2 * H + 24,
    tabindex: 0, role: 'slider', 'aria-label': `${pad.name} ${slider ? 'slider' : 'joystick'}`, 'data-pad': pad.id,
  },
    slider
      ? svg('line', { class: 'frame', x1: -R, y1: 0, x2: R, y2: 0 })
      : svg('rect', { class: 'frame', x: -R, y: -R, width: 2 * R, height: 2 * R, rx: 6 }),
    ...slots.map((s) => {
      const dot = svg('circle', { class: 'slot' + (pad.slots[s] ? ' set' : ''), cx: SLOT_POS[s][0] * R, cy: SLOT_POS[s][1] * H, r: 4 });
      dot.append(svg('title', {}, document.createTextNode(`${SLOT_LABEL[s]}: ${pad.slots[s] ? 'has a pose' : 'empty'}`)));
      return dot;
    }),
    knob,
  );
  let cur: Pt = { x: 0, y: 0 };
  const clamp = (p: Pt): Pt => ({ x: Math.min(1, Math.max(-1, p.x)), y: slider ? 0 : Math.min(1, Math.max(-1, p.y)) });
  const set = (p: Pt) => {
    cur = clamp(p);
    knob.setAttribute('x', String(cur.x * R - 9));
    knob.setAttribute('y', String(cur.y * H - 9));
    area.setAttribute('aria-valuetext', slider ? `${Math.round(cur.x * 100)}` : `${Math.round(cur.x * 100)}, ${Math.round(cur.y * 100)}`);
  };

  const fromPointer = (e: PointerEvent): Pt => {
    const box = area.getBoundingClientRect();
    const unit = box.width / (2 * R + 24);
    return clamp({ x: (e.clientX - box.left - box.width / 2) / (unit * R), y: (e.clientY - box.top - box.height / 2) / (unit * H) });
  };
  onDrag(area, (e) => { opts.onSelect(); (area as SVGSVGElement).focus(); opts.onKnob(fromPointer(e)); }, (e) => opts.onKnob(fromPointer(e)), opts.onEnd);
  area.addEventListener('dblclick', () => { opts.onKnob({ x: 0, y: 0 }); opts.onEnd(); });
  area.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.02 : 0.1;
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[e.key];
    if (!d) return;
    e.preventDefault();
    opts.onKnob(clamp({ x: cur.x + d[0], y: cur.y + d[1] }));
    opts.onEnd();
  });

  // The name bar moves the whole pad around the stage.
  const title = document.createElement('div');
  title.className = 'pad-title';
  title.textContent = pad.name;
  title.title = 'Drag to move this controller';
  const el = document.createElement('div');
  el.className = 'pad-ctl' + (opts.selected ? ' selected' : '');
  el.style.left = `${pad.at.x}px`;
  el.style.top = `${pad.at.y}px`;
  el.append(area, title);
  let grab = { x: 0, y: 0 }, at = { ...pad.at };
  onDrag(title, (e) => { opts.onSelect(); grab = { x: e.clientX - at.x, y: e.clientY - at.y }; }, (e) => {
    const parent = el.parentElement!.getBoundingClientRect();
    at = {
      x: Math.min(parent.width - 40, Math.max(0, e.clientX - grab.x)),
      y: Math.min(parent.height - 40, Math.max(0, e.clientY - grab.y)),
    };
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
  }, () => opts.onMoved(at));

  return { el, set };
}
