// The inspector: the layer list at the top, then whatever is selected — a character, an image, a text,
// the camera, a sound, the shot itself, or Export. Each part reads the editor's state, writes changes
// straight back, then asks the editor to refresh. Advanced settings are folded until opened.
import { capturePanel } from '../capture/panel';
import { exportMp4, exportPng, exportPngSequence } from '../export/video';
import { levelIssues } from '../import/build';
import { canBend, defaultVariant, restPose, swapOptions } from '../model/pose';
import { mirrorAngles } from '../model/pads';
import { JOINTS, MOUTH_SHAPES, OVERLAY_SLOTS, type JointId } from '../model/skeleton';
import {
  defaultCameras, flapsFromVolume, FORMATS, FPS, MAX_ACTORS, moveInStack, setMouthKey, stackOrder, timingAt, toSrt, uid,
  type Actor, type Background, type LoopPose, type SceneTemplate, type TextItem, type Timing,
} from '../model/shot';
import { clipStart, LANE_LABEL, placeClip, type SceneClip } from '../model/storyboard';
import type { SavedPose } from '../model/types';
import { slug } from '../project/project';
import { h } from './dom';
import type { Editor } from './editor';
import { issueList } from './importer';

type Kid = Node | string | null | false | undefined | Kid[];
const section = (title: string, ...kids: Kid[]) => h('section', {}, h('h3', {}, title), ...(kids as Node[]));
/** A group that stays folded until asked for. The editor remembers which are open. */
const more = (ed: Editor, key: string, title: string, ...kids: Kid[]) => h('details', {
  class: 'more', 'data-more': key, open: ed.openAll || ed.open.has(key),
  ontoggle: (e: Event) => { if ((e.target as HTMLDetailsElement).open) ed.open.add(key); else ed.open.delete(key); },
}, h('summary', {}, title), h('div', { class: 'more-body' }, ...(kids as Node[]).flat(3).filter(Boolean) as Node[]));

/** The output shapes offered. 4:3 and 3:4 are cut in the owner's plan (old shots keep their framings). */
export const SHAPES = FORMATS.filter((f) => f.id !== 'yt43' && f.id !== 'post34');

/** Change what a slot shows on the selected character. Once a mouth has keys, the mouth row owns it. */
export function setSwap(ed: Editor, slot: string, value: string) {
  const actor = ed.sel(), pose = ed.pose();
  if (!actor || !pose) return;
  if (slot === 'mouth' && actor.mouth.length) setMouthKey(actor, ed.frame, value);
  pose.swaps = { ...pose.swaps, [slot]: value };
  if (!value) delete pose.swaps[slot];
  if (!Object.keys(pose.swaps).length) pose.swaps = undefined;
  ed.edited();
  ed.refresh();
}
/** Slots with their own control on the character itself. */
const ON_CHARACTER = ['mouth', 'hand_L', 'hand_R'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const jointLabel = (id: string) => cap(id.replace(/_([LR])$/, (_, s) => (s === 'L' ? ' left' : ' right')));
const GROUP_LABEL: Record<string, string> = {
  head: 'Head', hair_back: 'Hair (back)', torso: 'Torso', arm_L: 'Arm left', arm_R: 'Arm right', leg_L: 'Leg left', leg_R: 'Leg right',
};
const SLOT_NAMES: Record<string, string> = { mouth: 'Mouth', eyes: 'Eyes', hair: 'Hair' };
const round2 = (n: number) => Math.round(n * 100) / 100;
const fileLabel = (file: string) => file.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');

function num(label: string, value: number, set: (n: number) => void, opts: { min?: number; max?: number; step?: number; id?: string } = {}) {
  return h('label', { class: 'field' }, h('span', {}, label), h('input', {
    type: 'number', value: round2(value), step: opts.step ?? 1, min: opts.min, max: opts.max, id: opts.id,
    onchange: (e: Event) => {
      const n = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(n)) set(Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, n)));
    },
  }));
}
export function pickFiles(accept: string, multiple: boolean, done: (files: { name: string; bytes: Uint8Array }[]) => void) {
  const input = h('input', {
    type: 'file', accept, multiple,
    onchange: async () => done(await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name.replace(/[^\w.\- ]+/g, '_'), bytes: new Uint8Array(await f.arrayBuffer()) })))),
  });
  input.click();
}
function orderList(order: string[], names: (id: string) => string, onChange: (next: string[]) => void): HTMLElement {
  const shown = [...order].reverse(); // front-most on top, like a layers panel
  const swap = (i: number, k: number) => { const next = [...shown]; [next[i], next[k]] = [next[k], next[i]]; onChange(next.reverse()); };
  return h('ol', { class: 'order' }, shown.map((g, i) => h('li', {},
    h('span', {}, names(g)),
    h('button', { title: 'Move forward', 'aria-label': `Move ${names(g)} forward`, disabled: i === 0, onclick: () => swap(i, i - 1) }, 'Up'),
    h('button', { title: 'Move back', 'aria-label': `Move ${names(g)} back`, disabled: i === shown.length - 1, onclick: () => swap(i, i + 1) }, 'Down'),
  )));
}

// --- Layers: one list, front at the top ---------------------------------------------
function layersList(ed: Editor): HTMLElement {
  const { shot } = ed, order = stackOrder(shot).reverse(); // front first
  const nameOf = (id: string) => {
    const a = shot.actors.find((x) => x.id === id);
    if (a) return { name: a.character, kind: a.role === 'extra' ? 'Extra' : 'Character', item: a as Actor | Background };
    const b = shot.backgrounds.find((x) => x.id === id)!;
    return { name: fileLabel(b.file), kind: 'Image', item: b as Actor | Background };
  };
  const toggle = (item: Actor | Background, key: 'hidden' | 'locked', label: string, name: string) =>
    h('button', {
      class: 'layer-toggle' + (item[key] ? ' on' : ''), 'aria-pressed': String(!!item[key]), 'data-toggle': key,
      'aria-label': `${label} ${name}`, title: key === 'hidden' ? (item.hidden ? 'Hidden. Click to show.' : 'Click to hide') : (item.locked ? 'Locked: cannot be picked on the stage. Click to unlock.' : 'Click to lock'),
      onclick: (e: Event) => { e.stopPropagation(); item[key] = !item[key] || undefined; if (key === 'hidden' && ed.focus === 'actor' && item.hidden) ed.select('shot'); ed.refresh(); },
    }, key === 'hidden' ? (item.hidden ? 'Show' : 'Hide') : (item.locked ? 'Unlock' : 'Lock'));

  const texts = shot.texts.filter((t) => t.kind === 'text');
  const list = h('ul', { class: 'layers', 'aria-label': 'Layers, front to back' },
    h('li', { class: 'layer fixed' + (ed.focus === 'camera' ? ' selected' : ''), 'data-layer': 'camera', onclick: () => { ed.select('camera'); ed.refresh(); } },
      h('span', { class: 'layer-name' }, 'Camera'), h('span', { class: 'layer-kind' }, ed.format().label)),
    texts.map((t) => h('li', { class: 'layer fixed' + (ed.selText === t.id ? ' selected' : ''), 'data-layer': t.id, onclick: () => { ed.select('text', t.id); ed.refresh(); } },
      h('span', { class: 'layer-name' }, t.text.replace(/\s+/g, ' ') || '(empty)'), h('span', { class: 'layer-kind' }, 'Text'))),
    order.map((id) => {
      const { name, kind, item } = nameOf(id);
      const selected = (ed.focus === 'actor' && ed.selId === id) || ed.selBg === id;
      return h('li', {
        class: 'layer stack' + (selected ? ' selected' : '') + (item.hidden ? ' is-hidden' : ''), 'data-layer': id, 'data-id': id,
        onclick: () => { if (kind === 'Image') ed.select('layer', id); else { ed.select('actor', id); ed.evaluateAll(); } ed.refresh(); },
      },
        h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
        h('span', { class: 'layer-name' }, name), h('span', { class: 'layer-kind' }, kind),
        toggle(item, 'hidden', item.hidden ? 'Show' : 'Hide', name), toggle(item, 'locked', item.locked ? 'Unlock' : 'Lock', name));
    }),
  );
  bindStackDrag(ed, list);
  return h('section', { class: 'layers-section' }, h('h3', {}, 'Layers'), list,
    order.length > 1 ? h('p', { class: 'meta' }, 'Drag a row to change what is in front.') : null);
}

/** Drag rows of the layer list to restack. The row follows the pointer; the others make room. */
function bindStackDrag(ed: Editor, list: HTMLElement) {
  let press: { el: HTMLElement; y: number; id: string; pointer: number } | null = null, dragging = false, target = -1;
  list.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('li.stack');
    if (!el || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    press = { el, y: e.clientY, id: el.dataset.id!, pointer: e.pointerId };
  });
  list.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.pointer) return;
    const dy = e.clientY - press.y;
    if (!dragging) {
      if (Math.abs(dy) < 4) return;
      dragging = true;
      press.el.setPointerCapture(e.pointerId);
      press.el.classList.add('lifted');
    }
    press.el.style.transform = `translateY(${dy}px)`;
    const rows = [...list.querySelectorAll<HTMLElement>('li.stack')];
    const others = rows.filter((r) => r !== press!.el);
    let i = others.findIndex((r) => { const b = r.getBoundingClientRect(); return e.clientY < b.top + b.height / 2; });
    if (i < 0) i = others.length;
    target = i; // index in the front-first list without the dragged row
    rows.forEach((r) => r.classList.remove('drop-above', 'drop-below'));
    if (others[i]) others[i].classList.add('drop-above'); else others[others.length - 1]?.classList.add('drop-below');
  });
  const end = (commit: boolean) => {
    if (!press) return;
    const { el, id } = press;
    if (dragging) {
      el.classList.remove('lifted');
      el.style.transform = '';
      list.querySelectorAll('.drop-above, .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
      if (commit && target >= 0) {
        const backToFrontIndex = stackOrder(ed.shot).length - 1 - target;
        moveInStack(ed.shot, id, backToFrontIndex);
        ed.refresh();
      }
    }
    press = null; dragging = false; target = -1;
  };
  list.addEventListener('pointerup', () => end(true));
  list.addEventListener('pointercancel', () => end(false));
}

// --- Character ----------------------------------------------------------------------
function actorPanel(ed: Editor): Kid[] {
  const actor = ed.sel(), rig = ed.rig(), v = ed.view(), pose = ed.pose(), entry = ed.entry(actor);
  if (!actor || !rig || !v || !pose || !entry) return [section('Nothing selected', h('p', { class: 'meta' }, 'Click a character, image or text on the stage, or a row in the list above.'))];
  if (ed.mode === 'rig') return rigPanel(ed);
  if (ed.mode === 'capture') return [section(`Pose ${actor.character} from a photo`), ...capturePanel(ed)];
  const { project, shot } = ed;
  const changed = () => { ed.edited(); ed.refresh(); };
  const acting = shot.actors.filter((a) => a.role === 'actor').length;
  const options = swapOptions(v);
  const slots = [...OVERLAY_SLOTS.filter((s) => options[s]), ...Object.keys(options).filter((s) => !OVERLAY_SLOTS.includes(s)).sort()].filter((s) => !ON_CHARACTER.includes(s));
  const mouths = options.mouth ?? [];

  const savePose = (rawName: string, rawTags: string) => {
    const name = rawName.trim() || `Pose ${project.poses.length + 1}`;
    const saved: SavedPose = {
      name, tags: rawTags.split(',').map((t) => t.trim()).filter(Boolean), view: pose.view, flip: pose.flip, rootAngle: pose.rootAngle,
      angles: Object.fromEntries(Object.entries(pose.angles).filter(([, a]) => a).map(([j, a]) => [j, round2(a)])),
      groupOrder: pose.groupOrder, swaps: pose.swaps, thumb: ed.stage.thumbnail({ id: actor.id, rig }),
    };
    const at = project.poses.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (at >= 0) project.poses[at] = saved; else project.poses.push(saved); // same name replaces
    ed.ctx.onChanged(); ed.renderPanel();
  };
  /** Angles are relative to each character's own rest pose, so a pose fits any character. */
  const applySaved = (p: SavedPose, mirror: boolean) => {
    const viewId = rig.views[p.view] ? p.view : pose.view;
    Object.assign(pose, {
      view: viewId, flip: p.flip, rootAngle: mirror ? -p.rootAngle : p.rootAngle,
      angles: mirror ? mirrorAngles(p.angles) : { ...p.angles }, groupOrder: undefined, swaps: p.swaps ? { ...p.swaps } : undefined,
    });
    changed();
  };
  const shownPoses = project.poses.filter((p) => !ed.poseFilter || `${p.name} ${p.tags.join(' ')}`.toLowerCase().includes(ed.poseFilter.toLowerCase()));
  const nameInput = h('input', { type: 'text', id: 'pose-name', placeholder: `Pose ${project.poses.length + 1}`, 'aria-label': 'Pose name' });
  const tagInput = h('input', { type: 'text', id: 'pose-tags', placeholder: 'Tags, separated by commas', 'aria-label': 'Pose tags' });
  const rangeFrom = h('input', { type: 'number', min: 1, value: ed.frame + 1, 'aria-label': 'From frame' });
  const rangeTo = h('input', { type: 'number', min: 1, value: Math.min(shot.length, ed.frame + 24), 'aria-label': 'To frame' });
  const rangeTiming = h('select', { 'aria-label': 'Timing for these frames' }, [1, 2, 3].map((t) => h('option', { value: t }, `${t}s`)));
  const loopPose = (): LoopPose => JSON.parse(JSON.stringify({ angles: pose.angles, view: pose.view, flip: pose.flip, rootAngle: pose.rootAngle, swaps: pose.swaps }));

  return [
    section(actor.character,
      h('div', { class: 'row' },
        h('select', { id: 'actor-role', 'aria-label': `Role of ${actor.character}`, onchange: (e: Event) => {
          const role = (e.target as HTMLSelectElement).value as 'actor' | 'extra';
          if (role === 'actor' && acting >= MAX_ACTORS) { ed.say(`A shot has at most ${MAX_ACTORS} acting characters. Make another one an extra first.`); ed.refresh(); return; }
          if (role === 'extra') actor.base = JSON.parse(JSON.stringify(pose));
          actor.role = role; ed.evaluateAll(); ed.refresh();
        } }, h('option', { value: 'actor', selected: actor.role === 'actor' }, 'Acting'), h('option', { value: 'extra', selected: actor.role === 'extra' }, 'Extra')),
        num('Size %', (pose.scale ?? 1) * 100, (n) => { ed.scaleActor(actor, n / 100); ed.refresh(); }, { min: 5, max: 800, step: 5, id: 'pose-scale' })),
      h('div', { class: 'row' },
        h('button', { id: 'place-mode', title: 'Drag the character to move it in every frame at once', onclick: () => ed.setMode('place') }, 'Move in every frame'),
        h('button', { id: 'reset-pose', onclick: () => { Object.assign(pose, { ...restPose(v, pose.view, pose.root), scale: pose.scale, pads: undefined, swaps: undefined, groupOrder: undefined }); changed(); } }, 'Reset pose')),
      h('div', { class: 'row' },
        h('button', { id: 'bar-capture', onclick: () => ed.setMode('capture') }, 'Pose from a photo'),
        h('button', { id: 'edit-rig', onclick: () => ed.setMode('rig') }, 'Edit rig'))),

    actor.role === 'extra' ? section('Movement',
      h('p', { class: 'meta' }, 'An extra never needs keys. It stands still, or loops through a few poses.'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Movement' },
        h('button', { class: actor.loop ? '' : 'selected', id: 'extra-still', onclick: () => { actor.loop = undefined; ed.evaluateAll(); ed.refresh(); } }, 'Stand still'),
        h('button', { class: actor.loop ? 'selected' : '', id: 'extra-loop', onclick: () => { actor.loop ??= { hold: 12, poses: [loopPose()] }; ed.evaluateAll(); ed.refresh(); } }, 'Loop')),
      actor.loop ? [
        h('p', { class: 'meta', id: 'loop-count' }, `${actor.loop.poses.length} ${actor.loop.poses.length === 1 ? 'pose' : 'poses'} in the loop. Pose the extra, then add the pose.`),
        h('div', { class: 'row' },
          h('button', { id: 'loop-add', onclick: () => { actor.loop!.poses.push(loopPose()); ed.evaluateAll(); ed.refresh(); } }, 'Add this pose'),
          project.poses.length ? h('select', { 'aria-label': 'Add a saved pose to the loop', onchange: (e: Event) => {
            const p = project.poses.find((x) => x.name === (e.target as HTMLSelectElement).value);
            if (p) { actor.loop!.poses.push({ angles: { ...p.angles }, view: rig.views[p.view] ? p.view : pose.view, flip: p.flip, rootAngle: p.rootAngle, swaps: p.swaps }); ed.evaluateAll(); ed.refresh(); }
          } }, h('option', { value: '' }, 'Add a saved pose…'), project.poses.map((p) => h('option', { value: p.name }, p.name))) : null),
        h('div', { class: 'row' },
          num('Each pose, frames', actor.loop.hold, (n) => { actor.loop!.hold = Math.round(n); ed.evaluateAll(); ed.refresh(); }, { min: 1, max: 240, id: 'loop-hold' }),
          h('button', { disabled: actor.loop.poses.length < 2, onclick: () => { actor.loop!.poses.pop(); ed.evaluateAll(); ed.refresh(); } }, 'Remove the last')),
      ] : null) : null,

    slots.length ? section('Other swaps', h('div', { class: 'swaps' }, slots.map((slot) => {
      const overlay = OVERLAY_SLOTS.includes(slot);
      const current = pose.swaps?.[slot] ?? (overlay ? defaultVariant(options[slot]) : '');
      return h('label', { class: 'field wide' }, h('span', {}, SLOT_NAMES[slot] ?? jointLabel(slot)),
        h('select', { 'data-swap': slot, onchange: (e: Event) => setSwap(ed, slot, (e.target as HTMLSelectElement).value) },
          overlay ? null : h('option', { value: '', selected: !current }, 'As drawn'),
          options[slot].map((o) => h('option', { value: o, selected: o === current }, o)),
          overlay ? h('option', { value: 'none', selected: current === 'none' }, 'Hidden') : null));
    }))) : null,

    mouths.length && actor.role === 'actor' ? section('Mouth',
      h('p', { class: 'meta' }, 'Click the shape the mouth should make from this frame on. The keys show in the mouth row under Voice on the timeline.'),
      h('div', { class: 'mouths' }, [...MOUTH_SHAPES.filter((m) => mouths.includes(m)), ...mouths.filter((m) => !MOUTH_SHAPES.includes(m))].map((m) =>
        h('button', { class: pose.swaps?.mouth === m ? 'selected' : '', 'data-mouth': m, onclick: () => { setMouthKey(actor, ed.frame, m); ed.evaluateAll(); ed.refresh(); } }, m))),
      h('div', { class: 'row' },
        h('button', { disabled: !actor.mouth.some((m) => m.frame === ed.frame), onclick: () => { actor.mouth = actor.mouth.filter((m) => m.frame !== ed.frame); ed.evaluateAll(); ed.refresh(); } }, 'Delete this mouth key'),
        h('button', { disabled: !actor.mouth.length, onclick: () => { actor.mouth = []; ed.evaluateAll(); ed.refresh(); } }, 'Clear all'))) : null,

    h('section', { id: 'library' },
      h('h3', {}, 'Pose library'),
      h('div', { class: 'save-pose' }, nameInput, tagInput,
        h('button', { id: 'save-pose', onclick: () => savePose(nameInput.value, tagInput.value) }, 'Save this pose')),
      project.poses.length > 6 || ed.poseFilter ? h('input', {
        type: 'search', id: 'pose-filter', placeholder: 'Find by name or tag', value: ed.poseFilter, 'aria-label': 'Find a pose',
        oninput: (e: Event) => { ed.poseFilter = (e.target as HTMLInputElement).value; ed.renderPanel(); (document.getElementById('pose-filter') as HTMLInputElement | null)?.focus(); },
      }) : null,
      project.poses.length
        ? h('ul', { class: 'poses' }, shownPoses.map((p) => h('li', { 'data-pose': p.name },
            h('button', { class: 'pose-card', title: `Apply ${p.name}`, onclick: () => applySaved(p, false) },
              p.thumb ? h('img', { src: p.thumb, alt: '' }) : h('span', { class: 'no-thumb' }),
              h('span', { class: 'pose-name' }, p.name),
              p.tags.length ? h('span', { class: 'meta' }, p.tags.join(', ')) : null),
            h('div', { class: 'pose-actions' },
              h('button', { title: 'Apply with left and right swapped', 'aria-label': `Apply ${p.name} mirrored`, onclick: () => applySaved(p, true) }, 'Mirror'),
              h('button', { title: 'Delete from the library', 'aria-label': `Delete ${p.name}`, onclick: () => { project.poses.splice(project.poses.indexOf(p), 1); ed.ctx.onChanged(); ed.renderPanel(); } }, 'Delete')))))
        : h('p', { class: 'meta' }, 'No saved poses yet. A saved pose can be applied to any character.')),

    more(ed, 'timing', 'Timing for this character or a frame range',
      h('p', { class: 'meta' }, `1s shows a new drawing every frame, 2s holds each for two frames, 3s for three. The shot is on ${shot.timing}s; this character is on ${timingAt(shot, actor, ed.frame)}s at this frame. Swaps always step.`),
      h('label', { class: 'field wide' }, h('span', {}, 'This character'),
        h('select', { id: 'actor-timing', onchange: (e: Event) => { const n = Number((e.target as HTMLSelectElement).value); actor.timing = n ? (n as Timing) : undefined; ed.evaluateAll(); ed.refresh(); } },
          h('option', { value: 0, selected: !actor.timing }, 'Same as the shot'), [1, 2, 3].map((t) => h('option', { value: t, selected: actor.timing === t }, `${t}s`)))),
      h('div', { class: 'range-add' }, 'Frames', rangeFrom, 'to', rangeTo, rangeTiming,
        h('button', { id: 'add-range', onclick: () => {
          const from = Math.max(1, Number(rangeFrom.value) || 1), to = Math.max(from, Number(rangeTo.value) || from);
          shot.timingRanges.push({ from: from - 1, to: to - 1, timing: Number(rangeTiming.value) as Timing });
          ed.evaluateAll(); ed.refresh();
        } }, 'Add')),
      shot.timingRanges.length ? h('ul', { class: 'items' }, shot.timingRanges.map((r, i) => h('li', {}, h('div', { class: 'row' },
        h('span', {}, `Frames ${r.from + 1} to ${r.to + 1}: ${r.timing}s, every character`),
        h('button', { 'aria-label': 'Remove this range', onclick: () => { shot.timingRanges.splice(i, 1); ed.evaluateAll(); ed.refresh(); } }, 'Remove'))))) : null),

    section('', h('button', { id: 'remove-actor', onclick: () => ed.removeSelected() }, `Remove ${actor.character} from this shot`)),
  ];
}

// --- Rig: an editing mode on the selected character ----------------------------------------
function rigPanel(ed: Editor): Kid[] {
  const actor = ed.sel()!, rig = ed.rig()!, v = ed.view()!, entry = ed.entry(actor)!;
  const unlocked = ed.unlocked();
  const limitInput = (j: JointId, index: 0 | 1) => h('input', {
    type: 'number', min: -180, max: 180, step: 5, placeholder: index ? '180' : '-180', 'aria-label': `${jointLabel(j)} ${index ? 'maximum' : 'minimum'} degrees`,
    value: rig.limits[j]?.[index] ?? '',
    onchange: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      const cur: [number, number] = rig.limits[j] ? [...rig.limits[j]] : [-180, 180];
      cur[index] = raw === '' ? (index ? 180 : -180) : Math.min(180, Math.max(-180, Number(raw)));
      if (cur[0] > cur[1]) cur[1 - index] = cur[index];
      if (cur[0] <= -180 && cur[1] >= 180) delete rig.limits[j]; else rig.limits[j] = cur;
      ed.refresh();
    },
  });
  const bends = { low: 'neck, shoulders and hips', medium: 'neck, shoulders, elbows, hips and knees', high: 'every joint' }[rig.level];
  return [
    section(`Edit rig: ${actor.character}`,
      h('p', { class: 'meta' }, `Drag a pivot on the stage to move it. This character bends at ${bends}, worked out from the pieces in the art.`),
      h('button', { class: 'primary', id: 'rig-done', onclick: () => ed.setMode('pose') }, 'Done editing the rig')),
    section('Check report', issueList([...levelIssues(rig, rig.level), ...entry.data.issues])),
    more(ed, 'limits', 'Joint limits',
      h('p', { class: 'meta' }, 'Degrees from the rest pose. Empty means free.'),
      h('table', { class: 'limits' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Joint'), h('th', {}, 'Min'), h('th', {}, 'Max'))),
        h('tbody', {}, JOINTS.filter((j) => v.pivots[j.id] && canBend(v, unlocked, j.id)).map((j) => h('tr', {
          class: ed.selJoint === j.id ? 'selected' : '',
          onpointerdown: () => { if (ed.selJoint !== j.id) { ed.selJoint = j.id; ed.redraw(); } },
        },
          h('td', {}, jointLabel(j.id)), h('td', {}, limitInput(j.id, 0)), h('td', {}, limitInput(j.id, 1))))))),
    more(ed, 'order', `Draw order, ${ed.pose()!.view} view`, orderList(v.groupOrder, (g) => GROUP_LABEL[g] ?? g, (next) => { v.groupOrder = next; ed.refresh(); })),
  ];
}

// --- Image layer ------------------------------------------------------------------------
function layerPanel(ed: Editor): Kid[] {
  const { shot } = ed, bg = shot.backgrounds.find((b) => b.id === ed.selBg);
  if (!bg) return [];
  return [section(fileLabel(bg.file),
    bg.locked ? h('p', { class: 'meta' }, 'Locked, so dragging on the stage never moves it. Unlock it in the list above to move it by hand.') : h('p', { class: 'meta' }, 'Drag it on the stage to place it. On the timeline, drag its bar to set when it shows.'),
    h('div', { class: 'grid2' },
      num('Size %', bg.scale * 100, (n) => { bg.scale = n / 100; ed.refresh(); }, { min: 1, max: 2000, step: 5, id: 'layer-size' }),
      num('Opacity %', (bg.opacity ?? 1) * 100, (n) => { bg.opacity = n / 100; ed.refresh(); }, { min: 0, max: 100, step: 5, id: 'layer-opacity' }),
      num('From frame', (bg.start ?? 0) + 1, (n) => { bg.start = Math.min(n - 1, (bg.end ?? shot.length) - 1) || undefined; ed.refresh(); }, { min: 1, id: 'layer-from' }),
      num('To frame', bg.end ?? shot.length, (n) => { bg.end = n >= shot.length ? undefined : Math.max(n, (bg.start ?? 0) + 1); ed.refresh(); }, { min: 1, id: 'layer-to' })),
    h('button', { id: 'remove-layer', onclick: () => ed.removeSelected() }, 'Remove this image'))];
}

// --- Text -------------------------------------------------------------------------------
const LOCAL_FONTS = ['sans-serif', 'serif', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'Noto Sans CJK JP', 'Arial', 'Helvetica Neue', 'Georgia', 'Impact', 'Comic Sans MS'];

function textFields(ed: Editor, t: TextItem): Kid[] {
  return [
    h('textarea', { rows: 2, 'aria-label': 'Text', id: 'text-body', value: t.text, onchange: (e: Event) => { t.text = (e.target as HTMLTextAreaElement).value; ed.refresh(); } }),
    h('div', { class: 'grid2' },
      num('From frame', t.start + 1, (n) => { t.start = Math.min(n - 1, t.end - 1); ed.refresh(); }, { min: 1 }),
      num('To frame', t.end, (n) => { t.end = Math.max(n, t.start + 1); ed.refresh(); }, { min: 1 }),
      t.kind === 'text' ? num('Size', t.size, (n) => { t.size = n; ed.refresh(); }, { min: 4 }) : null,
      t.kind === 'text' ? h('label', { class: 'field' }, h('span', {}, 'Colour'), h('input', { type: 'color', value: t.color, onchange: (e: Event) => { t.color = (e.target as HTMLInputElement).value; ed.refresh(); } })) : null),
  ];
}
function textPanel(ed: Editor): Kid[] {
  const t = ed.shot.texts.find((x) => x.id === ed.selText);
  if (!t) return [];
  return [section(t.kind === 'subtitle' ? 'Subtitle' : 'On-screen text',
    h('p', { class: 'meta' }, t.kind === 'subtitle' ? 'Subtitles sit at the bottom of every output shape.' : 'Drag it on the stage to place it.'),
    ...textFields(ed, t),
    h('button', { id: 'remove-text', onclick: () => ed.removeSelected() }, 'Remove this text'))];
}

// --- Camera -------------------------------------------------------------------------------
function cameraPanel(ed: Editor): Kid[] {
  const { shot } = ed, cam = ed.camera(), format = ed.format();
  const framed = () => { if (format.id !== 'yt') cam.custom = true; ed.refresh(); };
  return [section('Camera',
    h('label', { class: 'field wide' }, h('span', {}, 'Output shape'), shapeSelect(ed)),
    h('p', { class: 'meta' }, format.id === 'yt' ? 'Drag inside the blue frame to move it, a corner to resize it. The other shapes stay centred on this one until you frame them yourself.'
      : cam.custom ? 'You framed this shape yourself, so it no longer follows the 16:9 frame.' : 'This shape follows the 16:9 frame. Drag it to frame it on its own.'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'show-frame', checked: ed.showFrame, onchange: (e: Event) => { ed.showFrame = (e.target as HTMLInputElement).checked; ed.fitView(); ed.refresh(); } }), 'Show the frame'),
    h('button', { id: 'reset-framing', onclick: () => { if (format.id === 'yt') Object.assign(cam, defaultCameras(shot.stage).yt); else delete cam.custom; ed.fitView(); ed.refresh(); } },
      format.id === 'yt' ? 'Reset this framing' : 'Follow the 16:9 frame again')),
  more(ed, 'framing', `Framing numbers: ${format.label}`,
    h('div', { class: 'grid2' },
      num('Centre X', cam.x, (n) => { cam.x = n; framed(); }, { id: 'cam-x' }),
      num('Centre Y', cam.y, (n) => { cam.y = n; framed(); }, { id: 'cam-y' }),
      num('Width', cam.width, (n) => { cam.width = n; framed(); }, { min: 50, id: 'cam-w' })))];
}
function shapeSelect(ed: Editor) {
  return h('select', { id: 'format', 'aria-label': 'Output shape', onchange: (e: Event) => { ed.formatId = (e.target as HTMLSelectElement).value; ed.fitView(); ed.refresh(); } },
    [...SHAPES, ...FORMATS.filter((f) => f.id === ed.formatId && !SHAPES.includes(f))].map((f) => h('option', { value: f.id, selected: f.id === ed.formatId }, `${f.label} · ${f.w}×${f.h}`)));
}

// --- Sound clip ------------------------------------------------------------------------------
function clipPanel(ed: Editor): Kid[] {
  const sb = ed.project.storyboard, clip = sb?.sound?.find((c) => c.id === ed.selClip);
  if (!sb || !clip) return [];
  const { project } = ed;
  const at = clipStart(sb, project.shots, clip) ?? 0;
  const speakers = [...new Set(project.shots.flatMap((s) => s.actors.map((a) => a.character)))];
  const panelIndex = sb.panels.findIndex((p) => p.id === clip.panel);
  return [section(`${LANE_LABEL[clip.lane]}: ${fileLabel(clip.file)}`,
    h('p', { class: 'meta' }, `Starts ${(clip.offset / FPS).toFixed(2)} s into shot ${panelIndex + 1}. It plays across the cuts; moving or resizing shots keeps it with its shot.`),
    clip.lane === 'voice' ? h('label', { class: 'field wide' }, h('span', {}, 'Speaker'),
      h('select', { id: 'clip-speaker', onchange: (e: Event) => { clip.speaker = (e.target as HTMLSelectElement).value || undefined; ed.refresh(); } },
        h('option', { value: '' }, 'Nobody'), speakers.map((n) => h('option', { value: n, selected: n === clip.speaker }, n)))) : null,
    h('div', { class: 'grid2' },
      num('Volume %', clip.gain * 100, (n) => { clip.gain = n / 100; ed.refresh(); }, { min: 0, max: 200, step: 5, id: 'clip-volume' }),
      num('Starts at (s)', at / FPS, (n) => { placeClip(sb, project.shots, clip, Math.round(n * FPS)); ed.refresh(); }, { min: 0, step: 0.1, id: 'clip-start' })),
    h('label', { class: 'field wide' }, h('span', {}, 'Lane'),
      h('select', { id: 'clip-lane', onchange: (e: Event) => { clip.lane = (e.target as HTMLSelectElement).value as SceneClip['lane']; if (clip.lane !== 'voice') clip.speaker = undefined; ed.refresh(); } },
        (['voice', 'sfx', 'music'] as const).map((l) => h('option', { value: l, selected: l === clip.lane }, LANE_LABEL[l])))),
    clip.lane === 'voice' ? mouthFlaps(ed, clip) : null,
    h('button', { id: 'remove-clip', onclick: () => ed.removeSelected() }, 'Remove this sound'))];
}
/** Mouths stay manual (automatic mouths are for later), but the old loudness flaps are one click away for a quick start. */
function mouthFlaps(ed: Editor, clip: SceneClip): Kid {
  const actor = ed.shot.actors.find((a) => a.character === clip.speaker && a.role === 'actor');
  const view = actor && ed.view(actor), shapes = (view && swapOptions(view).mouth) || [];
  return more(ed, 'flaps', 'Quick mouth flaps from loudness',
    h('p', { class: 'meta' }, 'Opens and closes the speaker\'s mouth in this shot by how loud the line is. A rough start: set the real shapes in the Mouth section of the character.'),
    h('button', { 'data-flaps': clip.file, disabled: !actor || !shapes.length, onclick: () => {
      if (!actor) return;
      const vol = ed.audio.volume(clip.file), start = ed.clips().find((c) => c.id === clip.id)?.start ?? 0;
      actor.mouth = actor.mouth.filter((m) => m.frame < start || m.frame > start + vol.length);
      actor.mouth.push(...flapsFromVolume(vol, start, shapes, 2).filter((m) => m.frame >= 0 && m.frame < ed.shot.length));
      actor.mouth.sort((a, b) => a.frame - b.frame);
      ed.evaluateAll(); ed.refresh();
    } }, actor ? `Make flaps for ${actor.character}` : 'Choose a speaker in this shot first'));
}

// --- Shot -------------------------------------------------------------------------------
function shotPanel(ed: Editor): Kid[] {
  const { shot, project } = ed;
  const uploaded = [...project.assets.keys()].filter((p) => p.startsWith('fonts/')).map((p) => p.slice(6).replace(/\.[^.]+$/, ''));
  const fonts = [...new Set([shot.font, ...uploaded, ...project.googleFonts, ...LOCAL_FONTS])];
  const google = h('input', { type: 'text', id: 'google-font', placeholder: 'For example: Zen Maru Gothic', 'aria-label': 'Google font name' });
  const templateName = h('input', { type: 'text', id: 'template-name', placeholder: shot.name, 'aria-label': 'Template name' });
  const subs = shot.texts.filter((t) => t.kind === 'subtitle').sort((a, b) => a.start - b.start);
  const panel = ed.panel_(), n = panel ? (project.storyboard?.panels.indexOf(panel) ?? -1) + 1 : 0;
  return [
    section(n ? `Shot ${n}` : 'Shot',
      panel?.notes ? h('p', { class: 'notes', id: 'shot-notes' }, panel.notes) : h('p', { class: 'meta' }, 'Notes from the storyboard panel show here.'),
      h('p', { class: 'meta' }, `${shot.length} frames · ${(shot.length / FPS).toFixed(1)} s. Change the length on the timeline or on the storyboard.`)),
    section('Subtitles',
      h('button', { id: 'add-subtitle', onclick: () => {
        const item: TextItem = { id: uid(), kind: 'subtitle', text: 'Subtitle', start: ed.frame, end: Math.max(ed.frame + 1, Math.min(shot.length, ed.frame + 48)), x: 0, y: 0, size: 0, color: '' };
        shot.texts.push(item);
        ed.select('text', item.id);
        ed.refresh();
      } }, 'Add a subtitle at the playhead'),
      subs.length ? h('ul', { class: 'items' }, subs.map((t) => h('li', { 'data-text': 'subtitle', onclick: () => { if (ed.selText !== t.id) { ed.select('text', t.id); ed.refresh(); } } },
        h('span', {}, t.text || '(empty)'), h('span', { class: 'meta' }, ` · frames ${t.start + 1}–${t.end}`)))) : null),
    more(ed, 'font', `Font: ${shot.font}`,
      h('label', { class: 'field wide' }, h('span', {}, 'Text and subtitles'),
        h('select', { id: 'font', onchange: (e: Event) => { shot.font = (e.target as HTMLSelectElement).value; ed.refresh(); } },
          fonts.map((f) => h('option', { value: f, selected: f === shot.font }, f)))),
      h('p', { class: 'meta' }, 'Fonts in this list that are not installed on this computer fall back to a default.'),
      h('button', { id: 'upload-font', onclick: () => pickFiles('.ttf,.otf,.woff,.woff2', false, async (files) => {
        const f = files[0];
        if (!f) return;
        try { shot.font = await ed.loadFontFile(f.name, f.bytes); project.assets.set(`fonts/${f.name}`, f.bytes); } catch { ed.say(`${f.name} is not a font file the browser can use.`); }
        ed.refresh();
      }) }, 'Upload a font file…'),
      h('div', { class: 'save-pose' }, google,
        h('button', { id: 'add-google-font', title: 'Downloads the font from Google Fonts. This is the only thing in the app that goes online.', onclick: () => {
          const family = google.value.trim();
          if (!family) return;
          if (!project.googleFonts.includes(family)) project.googleFonts.push(family);
          ed.loadGoogleFont(family);
          shot.font = family;
          ed.refresh();
        } }, 'Use a Google font (goes online)'))),
    more(ed, 'stage', 'Stage size and colour',
      h('p', { class: 'meta' }, 'The drawing area, larger than every frame so one shot can be reframed for every shape.'),
      h('div', { class: 'grid2' },
        num('Width', shot.stage.w, (v) => { shot.stage.w = v; ed.refresh(); }, { min: 200, step: 10 }),
        num('Height', shot.stage.h, (v) => { shot.stage.h = v; ed.refresh(); }, { min: 200, step: 10 }),
        h('label', { class: 'field' }, h('span', {}, 'Colour'), h('input', { type: 'color', value: shot.stage.color, onchange: (e: Event) => { shot.stage.color = (e.target as HTMLInputElement).value; ed.refresh(); } })))),
    more(ed, 'templates', 'Reuse this setup in other shots',
      h('p', { class: 'meta' }, 'Saves the stage, images, characters and framing (not the animation), to start another shot from.'),
      h('div', { class: 'save-pose' }, templateName,
        h('button', { id: 'save-template', onclick: () => {
          const name = templateName.value.trim() || shot.name;
          const template: SceneTemplate = JSON.parse(JSON.stringify({
            name, stage: shot.stage, backgrounds: shot.backgrounds, cameras: shot.cameras,
            actors: shot.actors.map((a) => ({ character: a.character, role: a.role, base: ed.pose(a) ?? a.base })),
          }));
          const at = project.scenes.findIndex((s) => s.name === name);
          if (at >= 0) project.scenes[at] = template; else project.scenes.push(template);
          ed.ctx.onChanged(); ed.renderPanel();
        } }, 'Save the setup')),
      project.scenes.length ? h('ul', { class: 'items' }, project.scenes.map((s) => h('li', {},
        h('div', { class: 'row' }, h('strong', {}, s.name),
          h('span', {},
            h('button', { 'data-template': s.name, title: 'Replace this shot\'s images and characters with the saved setup', onclick: () => {
              const copy: SceneTemplate = JSON.parse(JSON.stringify(s));
              Object.assign(shot, { stage: copy.stage, backgrounds: copy.backgrounds.map((b) => ({ ...b, id: uid() })), cameras: copy.cameras, order: undefined,
                actors: copy.actors.map((a) => ({ ...a, id: uid(), keys: [], mouth: [] })) });
              ed.selId = shot.actors[0]?.id ?? null;
              ed.select('shot'); ed.evaluateAll(); ed.refresh();
            } }, 'Use here'),
            h('button', { 'aria-label': `Delete setup ${s.name}`, onclick: () => { project.scenes.splice(project.scenes.indexOf(s), 1); ed.ctx.onChanged(); ed.renderPanel(); } }, 'Delete')))))) : null),
  ];
}

// --- Export ----------------------------------------------------------------------
let burnSubtitles = true;
let exporting: { cancel: boolean } | null = null;

function exportPanel(ed: Editor): Kid[] {
  const { shot } = ed, format = ed.format();
  const status = h('p', { class: 'status', id: 'export-status', role: 'status' });
  const base = `${slug(shot.name)}_${format.id}`;
  const hasSubs = shot.texts.some((t) => t.kind === 'subtitle');

  const run = async (label: string, work: (job: { cancel: boolean }, progress: (d: number, t: number) => void) => Promise<string | void>) => {
    if (exporting) return;
    const job = (exporting = { cancel: false });
    const keep = ed.frame;
    ed.stop();
    ed.renderPanel();
    const line = document.getElementById('export-status')!;
    try {
      const note = await work(job, (d, t) => { line.textContent = `${label}: frame ${d} of ${t}`; });
      exporting = null;
      ed.setFrame(keep, { keep: true });
      ed.renderPanel();
      document.getElementById('export-status')!.textContent = note || `${label}: done.`;
    } catch (err) {
      exporting = null;
      ed.setFrame(keep, { keep: true });
      ed.renderPanel();
      const el = document.getElementById('export-status')!;
      el.className = 'status error';
      el.textContent = err instanceof Error ? err.message : String(err);
    }
  };
  const render = (f: number) => ed.outputFrame(f, burnSubtitles);

  return [
    section('Export this shot',
      h('label', { class: 'field wide' }, h('span', {}, 'Output shape'), shapeSelect(ed)),
      h('p', { class: 'meta' }, `${format.w} × ${format.h} px · ${shot.length} frames · ${(shot.length / FPS).toFixed(1)} s at ${FPS} fps, with the scene's sound for this shot. Each shape uses its own framing: select Camera in the layer list to change it.`),
      hasSubs ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'burn-subs', checked: burnSubtitles, onchange: (e: Event) => { burnSubtitles = (e.target as HTMLInputElement).checked; } }), 'Burn subtitles into the picture') : null,
      exporting
        ? h('button', { id: 'cancel-export', onclick: () => { if (exporting) exporting.cancel = true; } }, 'Cancel')
        : h('div', { class: 'stack' },
            h('button', { class: 'primary', id: 'export-mp4', onclick: () => run('Video', async (job, progress) => {
              const sound = await ed.audio.mixdown(ed.clips(), shot.length);
              const result = await exportMp4({ width: format.w, height: format.h, frames: shot.length, render, sound, onProgress: progress, cancelled: () => job.cancel });
              ed.ctx.download(`${base}.mp4`, result.bytes, 'video/mp4');
              ed.lastExport = result;
              return `Saved ${base}.mp4 (${result.video}${result.audio ? ` with ${result.audio} sound` : ', no sound'}). ${result.note ?? ''}`;
            }) }, 'Export video (MP4)'),
            h('button', { id: 'export-png-seq', onclick: () => run('PNG sequence', async (job, progress) => {
              ed.ctx.download(`${base}_frames.zip`, await exportPngSequence(shot.length, render, progress, () => job.cancel), 'application/zip');
              return `Saved ${base}_frames.zip.`;
            }) }, 'Export PNG sequence (zip)'),
            h('button', { id: 'export-frame', onclick: () => run('Frame', async () => {
              ed.ctx.download(`${base}_frame${ed.frame + 1}.png`, await exportPng(ed.outputFrame(ed.frame, burnSubtitles)), 'image/png');
              return `Saved frame ${ed.frame + 1} as a PNG.`;
            }) }, 'Export this frame (PNG)'),
            h('button', { id: 'export-srt', disabled: !hasSubs, onclick: () => { ed.ctx.download(`${slug(shot.name)}.srt`, new TextEncoder().encode(toSrt(shot)), 'application/x-subrip'); status.textContent = `Saved ${slug(shot.name)}.srt.`; } }, 'Export subtitles (.srt)')),
      status),
    section('Preview', h('p', { class: 'meta' }, 'What this shape shows at the current frame.'), preview(ed)),
  ];
}

function preview(ed: Editor): HTMLElement {
  const box = h('div', { class: 'preview' });
  // Drawn after the panel is in place, so a slow first render never blocks the click that opened it.
  requestAnimationFrame(() => {
    if (exporting || !box.isConnected) return;
    const canvas = ed.outputFrame(ed.frame, burnSubtitles, 300 / Math.max(ed.format().w, ed.format().h));
    box.replaceChildren(canvas);
    ed.redraw();
  });
  return box;
}

const PANELS = { shot: shotPanel, actor: actorPanel, layer: layerPanel, text: textPanel, camera: cameraPanel, clip: clipPanel, export: exportPanel };

export function renderInspector(ed: Editor) {
  const scroll = ed.panel.scrollTop;
  const body = PANELS[ed.focus](ed);
  // In a mode (rig, capture, placing) the inspector is about that one character; the layer list waits.
  ed.panel.replaceChildren(...[ed.mode === 'pose' || ed.mode === 'place' ? layersList(ed) : null, ...body].flat(4).filter(Boolean) as Node[]);
  ed.panel.scrollTop = scroll;
}
export type { Kid };
