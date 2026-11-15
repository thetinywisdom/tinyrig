// The side panel: one function per tab. Each reads the editor's state and
// writes changes straight back, then asks the editor to refresh.
import { capturePanel, stopWebcam } from '../capture/panel';
import { exportMp4, exportPng, exportPngSequence } from '../export/video';
import { levelIssues } from '../import/build';
import { canBend, clampToLimit, restPose, swapOptions, defaultVariant } from '../model/pose';
import {
  mirrorAngles, SCOPE_LABEL, setSlot, SLOT_LABEL, SLOT_POS, SLOTS, type Pad, type PadScope,
} from '../model/pads';
import { JOINTS, LEVELS, MOUTH_SHAPES, OVERLAY_SLOTS, type JointId } from '../model/skeleton';
import {
  defaultCameras, flapsFromVolume, FPS, MAX_ACTORS, setMouthKey, timingAt, toSrt, uid,
  type AudioClip, type SceneTemplate, type TextItem, type Timing,
} from '../model/shot';
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
const moreTitle = () => h('h3', { class: 'more-title' }, 'More');

/** Change what a slot shows on the selected character. Once a mouth has keys, lip sync owns it. */
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

function num(label: string, value: number, set: (n: number) => void, opts: { min?: number; max?: number; step?: number; id?: string } = {}) {
  return h('label', { class: 'field' }, h('span', {}, label), h('input', {
    type: 'number', value: round2(value), step: opts.step ?? 1, min: opts.min, max: opts.max, id: opts.id,
    onchange: (e: Event) => {
      const n = Number((e.target as HTMLInputElement).value);
      if (Number.isFinite(n)) set(Math.min(opts.max ?? Infinity, Math.max(opts.min ?? -Infinity, n)));
    },
  }));
}

function pickFiles(accept: string, multiple: boolean, done: (files: { name: string; bytes: Uint8Array }[]) => void) {
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
    h('button', { title: 'Move forward', 'aria-label': `Move ${names(g)} forward`, disabled: i === 0, onclick: () => swap(i, i - 1) }, '↑'),
    h('button', { title: 'Move back', 'aria-label': `Move ${names(g)} back`, disabled: i === shown.length - 1, onclick: () => swap(i, i + 1) }, '↓'),
  )));
}

const noCharacter = (ed: Editor) => section('No character selected',
  h('p', { class: 'meta' }, ed.shot.actors.length ? 'Click a character on the stage.' : 'This shot is empty.'),
  h('button', { class: 'primary', onclick: () => { ed.tab = 'scene'; ed.refresh(); } }, 'Go to the Scene step'));

/** Which character the panel is about, with a picker when the shot has several. */
function who(ed: Editor) {
  const actor = ed.sel();
  if (ed.shot.actors.length < 2 || !actor) return null;
  return h('section', { class: 'who' }, h('label', { class: 'field' }, h('span', {}, 'Character'),
    h('select', { id: 'actor', onchange: (e: Event) => { ed.selId = (e.target as HTMLSelectElement).value; ed.selJoint = null; ed.refresh(); } },
      ed.shot.actors.map((a) => h('option', { value: a.id, selected: a.id === actor.id }, a.character + (a.role === 'extra' ? ' (extra)' : ''))))));
}

// --- Rig -------------------------------------------------------------------------
function rigPanel(ed: Editor): Kid[] {
  const actor = ed.sel(), rig = ed.rig(), v = ed.view(), pose = ed.pose(), entry = ed.entry(actor);
  if (!actor || !rig || !v || !pose || !entry) return [noCharacter(ed)];
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
  return [
    who(ed),
    section('Check report', issueList([...levelIssues(rig, rig.level), ...entry.data.issues])),
    moreTitle(),
    more(ed, 'level', `Rig level: ${cap(rig.level)}`,
      h('p', { class: 'meta' }, 'Worked out from the pieces in the art. Lower levels lock the joints they skip; poses still work across levels.'),
      h('div', { class: 'seg' }, LEVELS.map((l) => h('button', { class: rig.level === l ? 'selected' : '', 'data-level': l, onclick: () => { rig.level = l; ed.refresh(); } }, cap(l))))),
    more(ed, 'limits', 'Joint limits',
      h('p', { class: 'meta' }, 'Degrees from the rest pose. Empty means free.'),
      h('table', { class: 'limits' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Joint'), h('th', {}, 'Min'), h('th', {}, 'Max'))),
        h('tbody', {}, JOINTS.filter((j) => v.pivots[j.id]).map((j) => h('tr', {
          class: (ed.selJoint === j.id ? 'selected ' : '') + (unlocked.has(j.id) ? '' : 'locked'),
          onpointerdown: () => { if (ed.selJoint !== j.id) { ed.selJoint = j.id; ed.redraw(); } },
        },
          h('td', {}, jointLabel(j.id), unlocked.has(j.id) ? null : h('span', { class: 'pill' }, 'Locked')),
          h('td', {}, limitInput(j.id, 0)), h('td', {}, limitInput(j.id, 1))))))),
    more(ed, 'order', `Draw order, ${pose.view} view`, orderList(v.groupOrder, (g) => GROUP_LABEL[g] ?? g, (next) => { v.groupOrder = next; ed.refresh(); })),
  ];
}

// --- Scene -----------------------------------------------------------------------
function scenePanel(ed: Editor): Kid[] {
  const { shot, project } = ed, cam = ed.camera(), format = ed.format();
  const actors = shot.actors, acting = actors.filter((a) => a.role === 'actor').length;
  const move = <T>(list: T[], i: number, d: number) => { const [x] = list.splice(i, 1); list.splice(i + d, 0, x); ed.refresh(); };
  const framed = () => { if (format.id !== 'yt') cam.custom = true; ed.refresh(); };
  const templateName = h('input', { type: 'text', id: 'template-name', placeholder: shot.name, 'aria-label': 'Template name' });

  return [
    section('Characters',
      h('p', { class: 'meta' }, `Up to ${MAX_ACTORS} acting characters. Extras hold one pose and cost almost nothing to play.`),
      actors.length ? h('ul', { class: 'items' }, [...actors].reverse().map((a) => {
        const i = actors.indexOf(a), pose = ed.pose(a);
        return h('li', { class: a.id === ed.selId ? 'selected' : '', 'data-actor': a.character, onpointerdown: () => { if (ed.selId !== a.id) { ed.selId = a.id; ed.redraw(); } } },
          h('div', { class: 'row' }, h('strong', {}, a.character),
            h('span', {},
              h('button', { title: 'Bring forward', 'aria-label': `Bring ${a.character} forward`, disabled: i === actors.length - 1, onclick: () => move(actors, i, 1) }, '↑'),
              h('button', { title: 'Send back', 'aria-label': `Send ${a.character} back`, disabled: i === 0, onclick: () => move(actors, i, -1) }, '↓'))),
          h('div', { class: 'row' },
            h('select', { 'aria-label': `Role of ${a.character}`, onchange: (e: Event) => {
              const role = (e.target as HTMLSelectElement).value as 'actor' | 'extra';
              if (role === 'actor' && acting >= MAX_ACTORS) { ed.say(`A shot has at most ${MAX_ACTORS} acting characters. Make another one an extra first.`); ed.refresh(); return; }
              if (role === 'extra') { a.base = JSON.parse(JSON.stringify(pose ?? a.base)); }
              a.role = role; ed.evaluateAll(); ed.refresh();
            } }, h('option', { value: 'actor', selected: a.role === 'actor' }, 'Acting'), h('option', { value: 'extra', selected: a.role === 'extra' }, 'Extra')),
            num('Size %', (pose?.scale ?? 1) * 100, (n) => { ed.scaleActor(a, n / 100); ed.refresh(); }, { min: 5, max: 800, step: 5 }),
            h('button', { 'aria-label': `Remove ${a.character} from the shot`, onclick: () => { actors.splice(i, 1); if (ed.selId === a.id) ed.selId = actors[0]?.id ?? null; ed.evaluateAll(); ed.refresh(); } }, 'Remove')));
      })) : null,
      h('div', { class: 'row' },
        project.characters.length ? h('select', { id: 'add-actor', 'aria-label': 'Character to add', onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) ed.addActor(v); } },
          h('option', { value: '' }, 'Add a character…'), project.characters.map((c) => h('option', { value: c.name }, c.name))) : null,
        h('button', { id: 'import-character', onclick: () => ed.ctx.importCharacter() }, 'Import new…'))),

    section('Image layers',
      h('p', { class: 'meta' }, 'Backgrounds, foregrounds and ornaments. On the timeline in Animate, drag a layer\'s bar to set when it shows.'),
      shot.backgrounds.length ? h('ul', { class: 'items' }, [...shot.backgrounds].reverse().map((bg) => {
        const i = shot.backgrounds.indexOf(bg);
        return h('li', { class: bg.id === ed.selBg ? 'selected' : '', onpointerdown: () => { ed.selBg = bg.id; ed.sceneTool = 'backgrounds'; ed.redraw(); } },
          h('div', { class: 'row' }, h('strong', {}, bg.file),
            h('span', {},
              h('button', { 'aria-label': `Bring ${bg.file} forward`, disabled: i === shot.backgrounds.length - 1, onclick: () => move(shot.backgrounds, i, 1) }, '↑'),
              h('button', { 'aria-label': `Send ${bg.file} back`, disabled: i === 0, onclick: () => move(shot.backgrounds, i, -1) }, '↓'))),
          h('div', { class: 'row' },
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!bg.front, onchange: (e: Event) => { bg.front = (e.target as HTMLInputElement).checked; ed.refresh(); } }), 'In front'),
            num('Size %', bg.scale * 100, (n) => { bg.scale = n / 100; ed.refresh(); }, { min: 1, max: 2000, step: 5 }),
            num('Opacity %', (bg.opacity ?? 1) * 100, (n) => { bg.opacity = n / 100; ed.refresh(); }, { min: 0, max: 100, step: 5 }),
            h('button', { 'aria-label': `Remove ${bg.file}`, onclick: () => { shot.backgrounds.splice(i, 1); ed.refresh(); } }, 'Remove')));
      })) : null,
      h('div', { class: 'row' },
        h('button', { id: 'add-background', onclick: () => ed.addImageLayer(false) }, 'Add behind…'),
        h('button', { id: 'add-foreground', onclick: () => ed.addImageLayer(true) }, 'Add in front…'))),

    moreTitle(),
    more(ed, 'framing', `Framing numbers: ${format.label}`,
      h('p', { class: 'meta' }, format.id === 'yt' ? 'The other shapes stay centred on this one until you frame them yourself.'
        : cam.custom ? 'You framed this shape yourself, so it no longer follows the 16:9 frame.' : 'This shape follows the 16:9 frame. Drag it or change a number to frame it on its own.'),
      h('div', { class: 'grid2' },
        num('Centre X', cam.x, (n) => { cam.x = n; framed(); }, { id: 'cam-x' }),
        num('Centre Y', cam.y, (n) => { cam.y = n; framed(); }, { id: 'cam-y' }),
        num('Width', cam.width, (n) => { cam.width = n; framed(); }, { min: 50, id: 'cam-w' })),
      h('button', { id: 'reset-framing', onclick: () => { if (format.id === 'yt') Object.assign(cam, defaultCameras(shot.stage).yt); else delete cam.custom; ed.fitView(); ed.refresh(); } },
        format.id === 'yt' ? 'Reset this framing' : 'Follow the 16:9 frame again')),

    more(ed, 'stage', 'Stage size and colour',
      h('p', { class: 'meta' }, 'The drawing area, larger than every frame so one shot can be reframed for every shape.'),
      h('div', { class: 'grid2' },
        num('Width', shot.stage.w, (n) => { shot.stage.w = n; ed.refresh(); }, { min: 200, step: 10 }),
        num('Height', shot.stage.h, (n) => { shot.stage.h = n; ed.refresh(); }, { min: 200, step: 10 }),
        h('label', { class: 'field' }, h('span', {}, 'Colour'), h('input', { type: 'color', value: shot.stage.color, onchange: (e: Event) => { shot.stage.color = (e.target as HTMLInputElement).value; ed.refresh(); } })))),

    more(ed, 'templates', 'Shot name and templates',
      h('label', { class: 'field wide' }, h('span', {}, 'Shot name'), h('input', { type: 'text', id: 'shot-name', value: shot.name, onchange: (e: Event) => {
        const name = (e.target as HTMLInputElement).value.trim();
        if (name && !project.shots.some((s) => s !== shot && s.name === name)) { shot.name = name; ed.refresh(); } else ed.refresh();
      } })),
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
        } }, 'Save this scene as a template')),
      project.scenes.length ? h('ul', { class: 'items' }, project.scenes.map((s) => h('li', {},
        h('div', { class: 'row' }, h('strong', {}, s.name),
          h('span', {},
            h('button', { 'data-template': s.name, onclick: () => {
              let name = `${s.name} shot`, n = 2;
              while (project.shots.some((x) => x.name === name)) name = `${s.name} shot ${n++}`;
              const copy: SceneTemplate = JSON.parse(JSON.stringify(s));
              project.shots.push({
                name, length: 96, timing: shot.timing, timingRanges: [], stage: copy.stage, backgrounds: copy.backgrounds.map((b) => ({ ...b, id: uid() })),
                actors: copy.actors.map((a) => ({ ...a, id: uid(), keys: [], mouth: [] })), cameras: copy.cameras, texts: [], audio: [], font: shot.font,
              });
              ed.ctx.onChanged(); ed.ctx.onShot(name);
            } }, 'New shot from this'),
            h('button', { 'aria-label': `Delete template ${s.name}`, onclick: () => { project.scenes.splice(project.scenes.indexOf(s), 1); ed.ctx.onChanged(); ed.renderPanel(); } }, 'Delete')))))) : null),
  ];
}

// --- Animate ---------------------------------------------------------------------
function animatePanel(ed: Editor): Kid[] {
  const actor = ed.sel(), rig = ed.rig(), v = ed.view(), pose = ed.pose();
  if (!actor || !rig || !v || !pose) return [noCharacter(ed)];
  const { project, shot } = ed, unlocked = ed.unlocked();
  const changed = () => { ed.edited(); ed.refresh(); };
  const joints = JOINTS.filter((j) => canBend(v, unlocked, j.id));
  const pad = project.pads.find((p) => p.id === ed.selPad) ?? null;
  const options = swapOptions(v);
  const slots = [...OVERLAY_SLOTS.filter((s) => options[s]), ...Object.keys(options).filter((s) => !OVERLAY_SLOTS.includes(s)).sort()].filter((s) => !ON_CHARACTER.includes(s));

  const newPad = (kind: Pad['kind']) => {
    const n = project.pads.filter((p) => p.kind === kind).length + 1;
    const made: Pad = { id: uid(), name: `${kind === 'slider' ? 'Slider' : 'Joystick'} ${n}`, kind, scope: 'body', slots: {}, at: { x: 16, y: 72 + (project.pads.length % 4) * 150 } };
    setSlot(pose, made, 'c'); // the pose it was made in is its centre
    project.pads.push(made);
    ed.selPad = made.id;
    changed();
  };
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
    const viewId = rig.views[p.view] ? p.view : pose.view, groups = rig.views[viewId]!.groupOrder;
    const order = p.groupOrder && p.view === viewId && [...p.groupOrder].sort().join() === [...groups].sort().join() ? p.groupOrder : undefined;
    Object.assign(pose, {
      view: viewId, flip: p.flip, rootAngle: mirror ? -p.rootAngle : p.rootAngle,
      angles: mirror ? mirrorAngles(p.angles) : { ...p.angles }, groupOrder: mirror ? undefined : order, swaps: p.swaps ? { ...p.swaps } : undefined,
    });
    changed();
  };
  const shownPoses = project.poses.filter((p) => !ed.poseFilter || `${p.name} ${p.tags.join(' ')}`.toLowerCase().includes(ed.poseFilter.toLowerCase()));
  const nameInput = h('input', { type: 'text', id: 'pose-name', placeholder: `Pose ${project.poses.length + 1}`, 'aria-label': 'Pose name' });
  const tagInput = h('input', { type: 'text', id: 'pose-tags', placeholder: 'Tags, separated by commas', 'aria-label': 'Pose tags' });
  const angleInput = (id: string, text: string, value: number, set: (deg: number) => void) => h('label', {}, h('span', {}, text), h('input', {
    type: 'number', step: 1, min: -180, max: 180, value: Math.round(value), 'data-angle': id,
    onchange: (e: Event) => { set(Math.min(180, Math.max(-180, Number((e.target as HTMLInputElement).value) || 0))); changed(); },
  }));
  const rangeFrom = h('input', { type: 'number', min: 1, value: ed.frame + 1, 'aria-label': 'From frame' });
  const rangeTo = h('input', { type: 'number', min: 1, value: Math.min(shot.length, ed.frame + 24), 'aria-label': 'To frame' });
  const rangeTiming = h('select', { 'aria-label': 'Timing for these frames' }, [1, 2, 3].map((t) => h('option', { value: t }, `${t}s`)));

  return [
    who(ed),
    section('Pose',
      h('div', { class: 'row' },
        num('Size %', (pose.scale ?? 1) * 100, (n) => { pose.scale = n / 100; changed(); }, { min: 5, max: 800, step: 5, id: 'pose-scale' }),
        h('button', { id: 'reset-pose', onclick: () => { Object.assign(pose, { ...restPose(v, pose.view, pose.root), scale: pose.scale, pads: undefined, swaps: undefined, groupOrder: undefined }); changed(); } }, 'Reset pose'))),

    slots.length ? section('Other swaps', h('div', { class: 'swaps' }, slots.map((slot) => {
      const overlay = OVERLAY_SLOTS.includes(slot);
      const current = pose.swaps?.[slot] ?? (overlay ? defaultVariant(options[slot]) : '');
      return h('label', { class: 'field wide' }, h('span', {}, SLOT_NAMES[slot] ?? jointLabel(slot)),
        h('select', { 'data-swap': slot, onchange: (e: Event) => setSwap(ed, slot, (e.target as HTMLSelectElement).value) },
          overlay ? null : h('option', { value: '', selected: !current }, 'As drawn'),
          options[slot].map((o) => h('option', { value: o, selected: o === current }, o)),
          overlay ? h('option', { value: 'none', selected: current === 'none' }, 'Hidden') : null));
    }))) : null,

    h('section', { id: 'controllers' },
      h('h3', {}, 'Controllers'),
      h('p', { class: 'meta' }, 'A controller mixes poses you store in it. Pose the character, then store that pose in a slot. Moving the knob blends between the slots.'),
      h('div', { class: 'row' },
        h('button', { id: 'new-joystick', onclick: () => newPad('joystick') }, 'New joystick'),
        h('button', { id: 'new-slider', onclick: () => newPad('slider') }, 'New slider')),
      project.pads.length ? h('ul', { class: 'pad-list' }, project.pads.map((p) => h('li', {},
        h('button', { class: 'pad-pick' + (p.id === ed.selPad ? ' selected' : ''), onclick: () => { ed.selPad = p.id; ed.refresh(); } },
          h('span', {}, p.name), h('span', { class: 'meta' }, `${p.kind === 'slider' ? 'Slider' : 'Joystick'} · ${SCOPE_LABEL[p.scope]}`))))) : null,
      pad ? h('div', { class: 'pad-edit' },
        h('label', {}, h('span', {}, 'Name'), h('input', { type: 'text', id: 'pad-name', value: pad.name, onchange: (e: Event) => { pad.name = (e.target as HTMLInputElement).value.trim() || pad.name; ed.refresh(); } })),
        h('label', {}, h('span', {}, 'Drives'), h('select', { id: 'pad-scope', onchange: (e: Event) => { pad.scope = (e.target as HTMLSelectElement).value as PadScope; ed.refresh(); } },
          (Object.keys(SCOPE_LABEL) as PadScope[]).map((sc) => h('option', { value: sc, selected: sc === pad.scope }, SCOPE_LABEL[sc])))),
        h('p', { class: 'meta' }, 'Slots. Click one to store the current pose there. Shift-click empties it.'),
        h('div', { class: 'slot-grid' + (pad.kind === 'slider' ? ' slider' : '') }, SLOTS.filter((sl) => pad.kind !== 'slider' || SLOT_POS[sl][1] === 0).map((sl) =>
          h('button', {
            class: pad.slots[sl] ? 'set' : '', 'data-slot': sl, title: `${SLOT_LABEL[sl]}: ${pad.slots[sl] ? 'has a pose. Click to replace it' : 'empty. Click to store the current pose'}`,
            onclick: (e: MouseEvent) => { if (e.shiftKey) { if (sl !== 'c') delete pad.slots[sl]; } else setSlot(pose, pad, sl); changed(); },
          }, SLOT_LABEL[sl]))),
        h('button', { id: 'delete-pad', onclick: () => { project.pads.splice(project.pads.indexOf(pad), 1); ed.selPad = null; ed.refresh(); } }, 'Delete this controller'),
      ) : null),

    h('section', { id: 'library' },
      h('h3', {}, 'Pose library'),
      h('div', { class: 'save-pose' }, nameInput, tagInput,
        h('button', { class: 'primary', id: 'save-pose', onclick: () => savePose(nameInput.value, tagInput.value) }, 'Save this pose')),
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

    moreTitle(),
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

    more(ed, 'angles', 'Exact angles', h('div', { class: 'angles' },
      angleInput('root', 'Whole character', pose.rootAngle, (d) => { pose.rootAngle = d; }),
      joints.map((j) => angleInput(j.id, jointLabel(j.id), pose.angles[j.id] ?? 0, (d) => { pose.angles[j.id] = clampToLimit(d, rig.limits[j.id]); })))),

    more(ed, 'pose-order', 'Draw order, this pose only',
      orderList(pose.groupOrder ?? v.groupOrder, (g) => GROUP_LABEL[g] ?? g, (next) => { pose.groupOrder = next; changed(); }),
      pose.groupOrder ? h('button', { onclick: () => { pose.groupOrder = undefined; changed(); } }, 'Back to default order') : null),
  ];
}

// --- Sound and text --------------------------------------------------------------
const LOCAL_FONTS = ['sans-serif', 'serif', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', 'Noto Sans JP', 'Noto Sans CJK JP', 'Arial', 'Helvetica Neue', 'Georgia', 'Impact', 'Comic Sans MS'];

function soundPanel(ed: Editor): Kid[] {
  const { shot, project } = ed, actor = ed.sel(), v = ed.view();
  const mouths = (v && swapOptions(v).mouth) || [];
  const uploaded = [...project.assets.keys()].filter((p) => p.startsWith('fonts/')).map((p) => p.slice(6).replace(/\.[^.]+$/, ''));
  const fonts = [...new Set([shot.font, ...uploaded, ...project.googleFonts, ...LOCAL_FONTS])];
  const google = h('input', { type: 'text', id: 'google-font', placeholder: 'For example: Zen Maru Gothic', 'aria-label': 'Google font name' });
  const addAudio = (kind: AudioClip['kind']) => pickFiles('audio/*', false, async (files) => {
    const f = files[0];
    if (!f) return;
    try {
      await ed.audio.load(f.name, f.bytes);
      project.assets.set(`audio/${f.name}`, f.bytes);
      shot.audio.push({ id: uid(), kind, file: f.name, start: ed.frame, gain: kind === 'music' ? 0.5 : 1, actor: kind === 'dialogue' ? actor?.id : undefined });
      shot.length = Math.max(shot.length, ed.frame + ed.audio.frames(f.name)); // make room for the whole sound
      const clip = shot.audio[shot.audio.length - 1];
      if (kind === 'dialogue' && mouths.length) flaps(clip); // the mouth moves straight away; refine it by hand after
    } catch { ed.say(`The browser could not read ${f.name} as sound. Try a WAV, MP3 or M4A file.`); }
    ed.refresh();
  });
  const flaps = (clip: AudioClip) => {
    const who2 = shot.actors.find((a) => a.id === clip.actor), view = who2 && ed.view(who2);
    const shapes = (view && swapOptions(view).mouth) || [];
    if (!who2 || !shapes.length) { ed.say('Choose who is speaking first. That character needs mouth shapes named mouth_rest, mouth_a and so on.'); return; }
    const vol = ed.audio.volume(clip.file);
    who2.mouth = who2.mouth.filter((m) => m.frame < clip.start || m.frame > clip.start + vol.length);
    who2.mouth.push(...flapsFromVolume(vol, clip.start, shapes, 2));
    who2.mouth.sort((a, b) => a.frame - b.frame);
    ed.evaluateAll(); ed.refresh();
  };
  const addSubtitle = () => {
    const item: TextItem = { id: uid(), kind: 'subtitle', text: 'Subtitle', start: ed.frame, end: Math.max(ed.frame + 1, Math.min(shot.length, ed.frame + 48)), x: 0, y: 0, size: 0, color: '' };
    shot.texts.push(item);
    ed.selText = item.id;
    ed.refresh();
  };

  const fontGroup = more(ed, 'font', `Font: ${shot.font}`,
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
      } }, 'Use a Google font (goes online)')));

  return [
    section('Sound',
      h('div', { class: 'row' },
        h('button', { id: 'add-dialogue', onclick: () => addAudio('dialogue') }, 'Add dialogue…'),
        h('button', { id: 'add-music', onclick: () => addAudio('music') }, 'Add music…')),
      h('p', { class: 'meta' }, 'A new sound starts at the playhead. Drag it on the timeline to move it.'),
      shot.audio.length ? h('ul', { class: 'items' }, shot.audio.map((clip, i) => h('li', { 'data-clip': clip.file },
        h('div', { class: 'row' }, h('strong', {}, clip.file), h('span', { class: 'meta' }, clip.kind === 'music' ? 'Music' : 'Dialogue')),
        clip.kind === 'dialogue' ? h('label', { class: 'field wide' }, h('span', {}, 'Speaker'),
          h('select', { 'aria-label': `Speaker of ${clip.file}`, onchange: (e: Event) => { clip.actor = (e.target as HTMLSelectElement).value || undefined; ed.refresh(); } },
            h('option', { value: '' }, 'Nobody'), shot.actors.map((a) => h('option', { value: a.id, selected: a.id === clip.actor }, a.character)))) : null,
        h('div', { class: 'row' },
          num('Starts at frame', clip.start + 1, (n) => { clip.start = n - 1; ed.refresh(); }, { min: 1 }),
          num('Volume %', clip.gain * 100, (n) => { clip.gain = n / 100; ed.refresh(); }, { min: 0, max: 200, step: 5 })),
        h('div', { class: 'row' },
          clip.kind === 'dialogue' ? h('button', { 'data-flaps': clip.file, title: 'Open and close the speaker\'s mouth from how loud the sound is', onclick: () => flaps(clip) }, 'Make mouth flaps') : h('span', {}),
          h('button', { 'aria-label': `Remove ${clip.file}`, onclick: () => { shot.audio.splice(i, 1); ed.refresh(); } }, 'Remove'))))) : null),

    section('Mouth shapes',
      !actor ? h('p', { class: 'meta' }, 'Select a character.') : !mouths.length
        ? h('p', { class: 'meta' }, `${actor.character} has no mouth shapes. Draw them on the head and name them mouth_rest, mouth_a, mouth_e, mouth_o, mouth_u, mouth_mbp, mouth_fv, mouth_l.`)
        : [
            h('p', { class: 'meta' }, `Scrub the timeline to hear the sound, then click the shape ${actor.character}'s mouth should make at this frame.`),
            h('div', { class: 'mouths' }, [...MOUTH_SHAPES.filter((m) => mouths.includes(m)), ...mouths.filter((m) => !MOUTH_SHAPES.includes(m))].map((m) =>
              h('button', { class: ed.pose(actor)?.swaps?.mouth === m ? 'selected' : '', 'data-mouth': m, onclick: () => { setMouthKey(actor, ed.frame, m); ed.evaluateAll(); ed.refresh(); } }, m))),
            h('div', { class: 'row' },
              h('button', { disabled: !actor.mouth.some((m) => m.frame === ed.frame), onclick: () => { actor.mouth = actor.mouth.filter((m) => m.frame !== ed.frame); ed.evaluateAll(); ed.refresh(); } }, 'Delete this mouth key'),
              h('button', { disabled: !actor.mouth.length, onclick: () => { actor.mouth = []; ed.evaluateAll(); ed.refresh(); } }, 'Clear all')),
          ]),

    section('Text and subtitles',
      h('div', { class: 'row' },
        h('button', { id: 'add-subtitle', onclick: addSubtitle }, 'Add subtitle'),
        h('button', { id: 'add-text', onclick: () => ed.addTextLayer() }, 'Add on-screen text')),
      h('p', { class: 'meta' }, 'Subtitles sit at the bottom of every output shape. On-screen text sits on the stage: drag it into place.'),
      shot.texts.length ? h('ul', { class: 'items' }, [...shot.texts].sort((a, b) => a.start - b.start).map((t) => h('li', { class: t.id === ed.selText ? 'selected' : '', 'data-text': t.kind, onpointerdown: () => { if (ed.selText !== t.id) { ed.selText = t.id; ed.timeline.draw(); } } },
        h('div', { class: 'row' }, h('span', { class: 'meta' }, t.kind === 'subtitle' ? 'Subtitle' : 'On-screen text'),
          h('button', { 'aria-label': 'Remove this text', onclick: () => { shot.texts.splice(shot.texts.indexOf(t), 1); ed.refresh(); } }, 'Remove')),
        h('textarea', { rows: 2, 'aria-label': 'Text', value: t.text, onchange: (e: Event) => { t.text = (e.target as HTMLTextAreaElement).value; ed.refresh(); } }),
        h('div', { class: 'row' },
          num('From frame', t.start + 1, (n) => { t.start = Math.min(n - 1, t.end - 1); ed.refresh(); }, { min: 1 }),
          num('To frame', t.end, (n) => { t.end = Math.max(n, t.start + 1); ed.refresh(); }, { min: 1 })),
        t.kind === 'text' ? h('div', { class: 'row' },
          num('Size', t.size, (n) => { t.size = n; ed.refresh(); }, { min: 4 }),
          h('label', { class: 'field' }, h('span', {}, 'Colour'), h('input', { type: 'color', value: t.color, onchange: (e: Event) => { t.color = (e.target as HTMLInputElement).value; ed.refresh(); } }))) : null))) : null),
    moreTitle(),
    fontGroup,
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
    section(`Export: ${format.label}`,
      h('p', { class: 'meta' }, `${format.w} × ${format.h} px · ${shot.length} frames · ${(shot.length / FPS).toFixed(1)} s at ${FPS} fps. Choose another shape in the toolbar; each uses its own framing from the Scene tab.`),
      hasSubs ? h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'burn-subs', checked: burnSubtitles, onchange: (e: Event) => { burnSubtitles = (e.target as HTMLInputElement).checked; } }), 'Burn subtitles into the picture') : null,
      exporting
        ? h('button', { id: 'cancel-export', onclick: () => { if (exporting) exporting.cancel = true; } }, 'Cancel')
        : h('div', { class: 'stack' },
            h('button', { class: 'primary', id: 'export-mp4', onclick: () => run('Video', async (job, progress) => {
              const sound = await ed.audio.mixdown(shot);
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
  // Drawn after the panel is in place, so a slow first render never blocks the click that opened the tab.
  requestAnimationFrame(() => {
    if (exporting) return;
    const canvas = ed.outputFrame(ed.frame, burnSubtitles, 300 / Math.max(ed.format().w, ed.format().h));
    box.replaceChildren(canvas);
    ed.redraw();
  });
  return box;
}

const PANELS = { rig: rigPanel, scene: scenePanel, animate: animatePanel, sound: soundPanel, capture: capturePanel, export: exportPanel };

export function renderPanel(ed: Editor) {
  if (ed.tab !== 'capture') stopWebcam(); // the camera is only on while its tab is open
  const scroll = ed.panel.scrollTop;
  ed.panel.replaceChildren(...(PANELS[ed.tab](ed).flat(4).filter(Boolean) as Node[]));
  ed.panel.scrollTop = scroll;
}
export type { Kid };
