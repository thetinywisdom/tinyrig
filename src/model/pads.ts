// Pose-blend controllers. A pad holds up to nine saved poses (centre, four
// edges, four corners); the knob position mixes them. Moving the knob adds the
// *change* in the mix to the pose, so anything posed by hand on top is kept,
// and several pads can drive the same joints.
import { JOINTS, SIDES, type Side } from './skeleton';
import type { Pose, Pt } from './types';

export type SlotId = 'nw' | 'n' | 'ne' | 'w' | 'c' | 'e' | 'sw' | 's' | 'se';
export const SLOTS: SlotId[] = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'];
/** Knob position of each slot. y points down, like the stage. */
export const SLOT_POS: Record<SlotId, [number, number]> = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], w: [-1, 0], c: [0, 0], e: [1, 0], sw: [-1, 1], s: [0, 1], se: [1, 1],
};
export const SLOT_LABEL: Record<SlotId, string> = {
  nw: 'Up left', n: 'Up', ne: 'Up right', w: 'Left', c: 'Centre', e: 'Right', sw: 'Down left', s: 'Down', se: 'Down right',
};

export type PadScope = 'body' | 'torso' | 'head' | 'arms' | 'arm_L' | 'arm_R' | 'legs' | 'leg_L' | 'leg_R';
export const SCOPE_LABEL: Record<PadScope, string> = {
  body: 'Whole body', torso: 'Torso', head: 'Head', arms: 'Both arms', arm_L: 'Arm left', arm_R: 'Arm right',
  legs: 'Both legs', leg_L: 'Leg left', leg_R: 'Leg right',
};

/** What a slot stores: joint angles by joint id, plus root.angle / root.x / root.y. */
export type Channels = Record<string, number>;

export interface Pad {
  id: string;
  name: string;
  /** A slider is a pad with one axis: left, centre, right. */
  kind: 'joystick' | 'slider';
  scope: PadScope;
  slots: Partial<Record<SlotId, Channels>>;
  /** Where the pad sits on the stage, in pixels from its top-left. */
  at: Pt;
}

const arm = (s: Side) => [`shoulder_${s}`, `elbow_${s}`, `wrist_${s}`];
const leg = (s: Side) => [`hip_${s}`, `knee_${s}`, `ankle_${s}`];

export function scopeChannels(scope: PadScope): string[] {
  switch (scope) {
    case 'body': return [...JOINTS.map((j) => j.id), 'root.angle', 'root.x', 'root.y'];
    case 'torso': return ['waist', 'root.angle'];
    case 'head': return ['neck'];
    case 'arms': return SIDES.flatMap(arm);
    case 'legs': return SIDES.flatMap(leg);
    case 'arm_L': return arm('L');
    case 'arm_R': return arm('R');
    case 'leg_L': return leg('L');
    case 'leg_R': return leg('R');
  }
}

function read(pose: Pose, channel: string): number {
  if (channel === 'root.angle') return pose.rootAngle;
  if (channel === 'root.x') return pose.root.x;
  if (channel === 'root.y') return pose.root.y;
  return pose.angles[channel] ?? 0;
}
function add(pose: Pose, channel: string, delta: number) {
  if (channel === 'root.angle') pose.rootAngle += delta;
  else if (channel === 'root.x') pose.root.x += delta;
  else if (channel === 'root.y') pose.root.y += delta;
  else pose.angles[channel] = (pose.angles[channel] ?? 0) + delta;
}

/** The current pose, limited to what a scope drives: what "set this slot" stores. */
export function capture(pose: Pose, scope: PadScope): Channels {
  return Object.fromEntries(scopeChannels(scope).map((ch) => [ch, Math.round(read(pose, ch) * 100) / 100]));
}

/** Value of one channel at a grid point (-1, 0 or 1 on each axis). Empty slots are filled in:
 *  an empty edge is the centre, an empty corner is the sum of its two edges. */
function gridValue(pad: Pad, ch: string, ix: number, iy: number): number {
  const slot = (id: SlotId) => pad.slots[id]?.[ch];
  const c = slot('c') ?? 0;
  if (!ix && !iy) return c;
  const horiz = ix ? slot(ix < 0 ? 'w' : 'e') ?? c : c;
  const vert = iy ? slot(iy < 0 ? 'n' : 's') ?? c : c;
  if (!iy) return horiz;
  if (!ix) return vert;
  return slot(((iy < 0 ? 'n' : 's') + (ix < 0 ? 'w' : 'e')) as SlotId) ?? horiz + vert - c;
}

/** The pad's mix of its slots at a knob position (each axis -1..1). */
export function blendPad(pad: Pad, knob: Pt): Channels {
  const x = Math.min(1, Math.max(-1, knob.x)), y = pad.kind === 'slider' ? 0 : Math.min(1, Math.max(-1, knob.y));
  const x0 = x < 0 ? -1 : 0, y0 = y < 0 ? -1 : 0, tx = x - x0, ty = y - y0;
  const out: Channels = {};
  for (const ch of scopeChannels(pad.scope)) {
    const top = gridValue(pad, ch, x0, y0) * (1 - tx) + gridValue(pad, ch, x0 + 1, y0) * tx;
    const bottom = gridValue(pad, ch, x0, y0 + 1) * (1 - tx) + gridValue(pad, ch, x0 + 1, y0 + 1) * tx;
    out[ch] = top * (1 - ty) + bottom * ty;
  }
  return out;
}

/** Move a pad's knob: the pose changes by the difference between the two mixes. */
export function moveKnob(pose: Pose, pad: Pad, to: Pt) {
  const from = pose.pads?.[pad.id] ?? { x: 0, y: 0 };
  const a = blendPad(pad, from), b = blendPad(pad, to);
  for (const ch of Object.keys(b)) if (b[ch] !== a[ch]) add(pose, ch, b[ch] - a[ch]);
  pose.pads = { ...pose.pads, [pad.id]: { x: to.x, y: pad.kind === 'slider' ? 0 : to.y } };
}

/** Store the current pose in a slot and park the knob there. */
export function setSlot(pose: Pose, pad: Pad, slot: SlotId) {
  pad.slots[slot] = capture(pose, pad.scope);
  pose.pads = { ...pose.pads, [pad.id]: { x: SLOT_POS[slot][0], y: SLOT_POS[slot][1] } };
}

/** Left and right swapped, as in a mirror. */
export function mirrorAngles(angles: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(angles)) {
    out[k.replace(/_([LR])$/, (_, s) => (s === 'L' ? '_R' : '_L'))] = -v;
  }
  return out;
}
