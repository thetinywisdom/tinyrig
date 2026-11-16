import { describe, expect, it } from 'vitest';
import { apply, boneMatrices, clampToLimit, normDeg, restPose, solveLimbIK, swingAround } from '../src/model/pose';
import { classifyName, defaultPartOrder, LIMBS, normalizeName, parsePartFileName, parseVariant, splitPsdLayerName, suggestLevel, unlockedJoints } from '../src/model/skeleton';
import { blendPad, capture, mirrorAngles, moveKnob, setSlot, type Pad } from '../src/model/pads';
import type { Rig, RigView } from '../src/model/types';

const view: RigView = {
  pieces: {},
  pivots: { shoulder_L: { x: 100, y: 100 }, elbow_L: { x: 100, y: 200 }, wrist_L: { x: 100, y: 300 }, hip_L: { x: 80, y: 300 } },
  rootPivot: { x: 60, y: 300 },
  tips: { arm_L: { x: 100, y: 300 } },
  groupOrder: [],
};
const rig: Rig = { version: 1, name: 't', source: 'svg', level: 'high', views: { front: view }, limits: {} };
const arm = LIMBS.find((l) => l.id === 'arm_L')!;
const high = unlockedJoints('high');

function tipOf(pose: ReturnType<typeof restPose>, unlocked = high) {
  return apply(boneMatrices(view, pose, unlocked).forearm_L, view.tips.arm_L!);
}

describe('names', () => {
  it('undoes what apps do to layer names', () => {
    expect(normalizeName('head_1_')).toBe('head');
    expect(normalizeName('forearm_L_2')).toBe('forearm_L');
    expect(normalizeName('upperarm_l_00000012345_')).toBe('upperarm_L');
    expect(normalizeName('hair_x5F_back')).toBe('hair_back');
    expect(normalizeName('Arm L')).toBe('arm_L');
    expect(normalizeName('shin_R-2')).toBe('shin_R');
  });
  it('classifies names', () => {
    expect(classifyName('char_momo')).toEqual({ kind: 'char', name: 'momo' });
    expect(classifyName('side')).toEqual({ kind: 'view', view: 'side' });
    expect(classifyName('hand_L')).toEqual({ kind: 'piece', name: 'hand_L', variant: false });
    expect(classifyName('hand_fist')).toEqual({ kind: 'piece', name: 'hand_fist', variant: true });
    expect(classifyName('mouths').kind).toBe('group');
    expect(parseVariant('forearm_L_bent')).toMatchObject({ slot: 'forearm_L', variant: 'bent', bone: 'forearm_L', group: 'arm_L' });
    expect(parseVariant('mouth_a')).toMatchObject({ slot: 'mouth', variant: 'a', overlay: true });
    expect(parseVariant('hand_fist')).toMatchObject({ slot: 'hand', shared: 'hand' });
    expect(parseVariant('hand_L_fist')).toMatchObject({ slot: 'hand_L', variant: 'fist' });
    expect(parseVariant('hair_back')).toBeNull();
    expect(classifyName('sparkle').kind).toBe('unknown');
  });
  it('splits Procreate layer names', () => {
    expect(splitPsdLayerName('forearm_L_line')).toEqual({ base: 'forearm_L', pass: 'line' });
    expect(splitPsdLayerName('head_fill')).toEqual({ base: 'head', pass: 'fill' });
    expect(splitPsdLayerName('head')).toEqual({ base: 'head', pass: null });
  });
  it('reads part file names', () => {
    expect(parsePartFileName('head.svg')).toEqual({ piece: 'head', view: null, char: null });
    expect(parsePartFileName('Forearm_l.svg').piece).toBe('forearm_L');
    expect(parsePartFileName('forearm_L.svg').piece).not.toBe('arm_L');
    expect(parsePartFileName('side_hair_back.svg')).toEqual({ piece: 'hair_back', view: 'side', char: null });
    expect(parsePartFileName('char_momo_back_upperarm_R-2.svg')).toEqual({ piece: 'upperarm_R', view: 'back', char: 'momo' });
    expect(parsePartFileName('hand_fist.svg')).toMatchObject({ piece: 'hand_fist' });
    expect(parsePartFileName('side_mouth_a.svg')).toMatchObject({ piece: 'mouth_a', view: 'side' });
    expect(parsePartFileName('sparkle.svg')).toMatchObject({ piece: null });
    expect(defaultPartOrder('side').indexOf('upperarm_R')).toBeLessThan(defaultPartOrder('side').indexOf('chest'));
  });
  it('suggests a rig level from the pieces found', () => {
    expect(suggestLevel(['head', 'torso', 'arm_L', 'leg_L'])).toBe('low');
    expect(suggestLevel(['head', 'torso', 'upperarm_L', 'forearm_L', 'hand_L'])).toBe('medium');
    expect(suggestLevel(['head', 'chest', 'pelvis'])).toBe('high');
  });
});

describe('pose', () => {
  it('wraps and clamps angles', () => {
    expect(normDeg(190)).toBe(-170);
    expect(normDeg(-180)).toBe(180);
    expect(clampToLimit(170, [-150, 150])).toBe(150);
  });
  it('rotates a child around its pivot and carries grandchildren', () => {
    const pose = restPose(view, 'front');
    pose.angles.shoulder_L = 90; // arm swings from pointing down to pointing left (y is down)
    const tip = tipOf(pose);
    expect(tip.x).toBeCloseTo(-100);
    expect(tip.y).toBeCloseTo(100);
  });
  it('lower rig levels lock the joints they skip', () => {
    const pose = restPose(view, 'front');
    pose.angles.elbow_L = 90;
    expect(tipOf(pose, unlockedJoints('low'))).toEqual({ x: 100, y: 300 });
    expect(tipOf(pose, unlockedJoints('medium')).x).toBeCloseTo(0);
  });
  it('IK puts the tip on the target, also when flipped and turned', () => {
    for (const flip of [false, true]) {
      const pose = { ...restPose(view, 'front'), flip, rootAngle: 25 };
      const target = { x: 150, y: 190 };
      const solved = solveLimbIK(rig, view, pose, high, arm, target)!;
      pose.angles = { shoulder_L: solved.upper, elbow_L: solved.lower };
      const tip = tipOf(pose);
      expect(tip.x).toBeCloseTo(target.x, 3);
      expect(tip.y).toBeCloseTo(target.y, 3);
    }
  });
  it('IK keeps the elbow on the same side while dragging', () => {
    const pose = restPose(view, 'front');
    pose.angles = { shoulder_L: -40, elbow_L: 80 };
    const solved = solveLimbIK(rig, view, pose, high, arm, tipOf(pose))!;
    expect(solved.upper).toBeCloseTo(-40, 3);
    expect(solved.lower).toBeCloseTo(80, 3);
  });
  it('IK respects joint limits and stretches no further than the limb', () => {
    const limited: Rig = { ...rig, limits: { elbow_L: [0, 150] } };
    const pose = restPose(view, 'front');
    const solved = solveLimbIK(limited, view, pose, high, arm, { x: 20, y: 160 })!;
    expect(solved.lower).toBeGreaterThanOrEqual(0);
    const far = solveLimbIK(rig, view, pose, high, arm, { x: 100, y: 900 })!;
    expect(far.lower).toBeCloseTo(0, 0);
  });
  it('IK is off when the level locks the elbow', () => {
    expect(solveLimbIK(rig, view, restPose(view, 'front'), unlockedJoints('low'), arm, { x: 0, y: 0 })).toBeNull();
  });
  it('FK drag measures the swing in the parent space, so a flip does not reverse it', () => {
    const pose = { ...restPose(view, 'front'), flip: true };
    const mats = boneMatrices(view, pose, high);
    const pivot = view.pivots.shoulder_L;
    const from = apply(mats.chest, { x: 100, y: 200 }), to = apply(mats.chest, { x: 0, y: 100 });
    expect(swingAround(mats.chest, pivot, from, to)).toBeCloseTo(90);
  });
});

describe('controller pads', () => {
  const pad = (): Pad => ({ id: 'p1', name: 'Arm', kind: 'joystick', scope: 'arm_L', at: { x: 0, y: 0 },
    slots: { c: { shoulder_L: 0, elbow_L: 0 }, e: { shoulder_L: 60, elbow_L: 0 }, n: { shoulder_L: 0, elbow_L: 90 } } });
  it('mixes its slots by knob position', () => {
    expect(blendPad(pad(), { x: 0.5, y: 0 }).shoulder_L).toBeCloseTo(30);
    expect(blendPad(pad(), { x: 0, y: -1 }).elbow_L).toBeCloseTo(90);
  });
  it('fills an empty edge with the centre and an empty corner with the sum of its edges', () => {
    expect(blendPad(pad(), { x: -1, y: 0 }).shoulder_L).toBeCloseTo(0);
    const corner = blendPad(pad(), { x: 1, y: -1 });
    expect(corner.shoulder_L).toBeCloseTo(60);
    expect(corner.elbow_L).toBeCloseTo(90);
    const drawn = pad();
    drawn.slots.ne = { shoulder_L: 10, elbow_L: 10 };
    expect(blendPad(drawn, { x: 1, y: -1 }).shoulder_L).toBeCloseTo(10);
  });
  it('keeps what was posed by hand on top, and leaves other joints alone', () => {
    const pose = restPose(view, 'front');
    pose.angles = { shoulder_L: 5, knee_L: 40 };
    moveKnob(pose, pad(), { x: 1, y: 0 });
    expect(pose.angles.shoulder_L).toBeCloseTo(65);
    expect(pose.angles.knee_L).toBe(40);
    moveKnob(pose, pad(), { x: 0, y: 0 });
    expect(pose.angles.shoulder_L).toBeCloseTo(5);
    expect(pose.pads!.p1).toEqual({ x: 0, y: 0 });
  });
  it('a slider only moves sideways', () => {
    const slider = { ...pad(), kind: 'slider' as const };
    expect(blendPad(slider, { x: 1, y: -1 }).elbow_L).toBeCloseTo(0);
  });
  it('stores the current pose in a slot, including body position for a whole-body pad', () => {
    const body: Pad = { id: 'b', name: 'Body', kind: 'joystick', scope: 'body', at: { x: 0, y: 0 }, slots: {} };
    const pose = restPose(view, 'front');
    setSlot(pose, body, 'c');
    pose.root.y += 30;
    pose.angles.knee_L = 50;
    setSlot(pose, body, 's');
    expect(pose.pads!.b).toEqual({ x: 0, y: 1 });
    moveKnob(pose, body, { x: 0, y: 0.5 });
    expect(pose.root.y).toBeCloseTo(view.rootPivot.y + 15);
    expect(pose.angles.knee_L).toBeCloseTo(25);
    expect(capture(pose, 'head')).toEqual({ neck: 0 });
  });
  it('mirrors a pose left to right', () => {
    expect(mirrorAngles({ shoulder_L: 30, knee_R: -10, neck: 5 })).toEqual({ shoulder_R: -30, knee_L: 10, neck: -5 });
  });
});

import { canonicalPart, classifyName as classify2 } from '../src/model/skeleton';
describe('part names written any way', () => {
  it('reads sides and part words in any order and case', () => {
    expect(canonicalPart('Arm L')).toBe('arm_L');
    expect(canonicalPart('L Arm')).toBe('arm_L');
    expect(canonicalPart('Left Arm')).toBe('arm_L');
    expect(canonicalPart('ArmLeft')).toBe('arm_L');
    expect(canonicalPart('Upper Arm R')).toBe('upperarm_R');
    expect(canonicalPart('lower-arm_L')).toBe('forearm_L');
    expect(canonicalPart('Lower Leg R')).toBe('shin_R');
    expect(canonicalPart('Calf L 2')).toBe('shin_L');
    expect(canonicalPart('Body')).toBe('torso');
    expect(canonicalPart('Hips')).toBe('pelvis');
    expect(canonicalPart('Arm')).toBeNull(); // which arm?
    expect(canonicalPart('Tail')).toBeNull();
    expect(classify2('Right Hand')).toEqual({ kind: 'piece', name: 'hand_R', variant: false });
  });
});
