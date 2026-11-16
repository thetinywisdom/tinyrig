import { describe, expect, it } from 'vitest';
import { boneMatrices, apply, restPose } from '../src/model/pose';
import { attachByName, bonesBelow, displayName, guessKind, nodeForName, sameName, skeletonOf, templateNodes, unlockedOf } from '../src/model/rig';
import type { Rig, RigView } from '../src/model/types';

const piece = (bone: string, x = 0) => ({ bone, group: bone, bbox: { x, y: 0, w: 10, h: 10 }, scale: 1, z: 0 });
const view = (pieces: Record<string, string>): RigView => ({
  pieces: Object.fromEntries(Object.entries(pieces).map(([n, b]) => [n, piece(b)])),
  pivots: {}, rootPivot: { x: 0, y: 0 }, tips: {}, groupOrder: Object.keys(pieces),
});
const rig = (v: RigView, nodes?: Rig['nodes']): Rig => ({ version: 1, name: 'x', source: 'svg', level: 'high', views: { front: v }, limits: {}, nodes });

describe('names', () => {
  it('reads the same part however it is written', () => {
    expect(sameName('L hand', 'hand_L')).toBe(true);
    expect(sameName('Left Hand', 'hand_L')).toBe(true);
    expect(sameName('L upper arm', 'upperarm_L')).toBe(true);
    expect(sameName('front L leg', 'leg_front_L')).toBe(true);
    expect(sameName('tail_2', 'Tail')).toBe(true);
    expect(sameName('L hand', 'R hand')).toBe(false);
    expect(sameName('hand', 'hand_L')).toBe(false);
  });

  it('shows layer names as words', () => {
    expect(displayName('hand_L')).toBe('L hand');
    expect(displayName('upperarm_R')).toBe('R upper arm');
    expect(displayName('pelvis')).toBe('Hips');
    expect(displayName('tail')).toBe('Tail');
    expect(displayName('ear_front_L')).toBe('L ear front');
  });
});

describe('rigs of your own', () => {
  it('the human rig keeps the joints photos drive', () => {
    const ids = templateNodes('human').map((n) => n.id);
    expect(ids).toContain('elbow_L');
    expect(templateNodes('human').find((n) => n.id === 'wrist_L')?.name).toBe('L hand');
    // A four-legged front leg is driven like an arm.
    expect(templateNodes('four').find((n) => n.id === 'shoulder_L')?.name).toBe('L front leg');
  });

  it('builds the skeleton from nodes, parents first', () => {
    const nodes = [
      { id: 'root', bone: 'body', name: 'Body', parent: null },
      { id: 'n_2', bone: 'n_2', name: 'Tail tip', parent: 'n_1' },
      { id: 'n_1', bone: 'n_1', name: 'Tail', parent: 'body' },
    ];
    const skel = skeletonOf({ nodes });
    expect(skel.root).toBe('body');
    expect(skel.joints.map((j) => j.id)).toEqual(['n_1', 'n_2']);
    expect(bonesBelow(nodes, 'n_1')).toEqual(new Set(['n_1', 'n_2']));
  });

  it('a tail of your own bends the layers that move with it', () => {
    const v = view({ body: 'body', tail: 'body' });
    v.pivots.n_1 = { x: 10, y: 0 };
    const r = rig(v, [{ id: 'root', bone: 'body', name: 'Body', parent: null }, { id: 'n_1', bone: 'n_1', name: 'Tail', parent: 'body' }]);
    attachByName(r);
    expect(v.pieces.tail.bone).toBe('n_1');
    const pose = { ...restPose(v, 'front'), angles: { n_1: 90 } };
    const mats = boneMatrices(v, pose, unlockedOf(r), skeletonOf(r));
    const p = apply(mats.n_1, { x: 20, y: 0 });
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(10);
    expect(apply(mats.body, { x: 20, y: 0 }).x).toBeCloseTo(20);
  });

  it('attaches layers by name and keeps the rest where they were', () => {
    const v = view({ hand_L: 'pelvis', torso: 'pelvis', hat: 'gone' });
    const r = rig(v, templateNodes('human'));
    attachByName(r);
    expect(v.pieces.hand_L.bone).toBe('hand_L');
    expect(v.pieces.torso.bone).toBe('pelvis');
    expect(v.pieces.hat.bone).toBe('pelvis'); // its node is gone: it rides the root
    expect(nodeForName(templateNodes('two'), 'Tail')?.id).toBe('tail');
  });

  it('guesses the rig from layer names', () => {
    expect(guessKind(['head', 'tail', 'leg_front_L', 'leg_back_L', 'paw_front_L'])).toBe('four');
    expect(guessKind(['head', 'tail', 'leg_L', 'leg_R', 'foot_L', 'foot_R', 'lower_leg_L'])).toBe('two');
  });

  it('Simple, Medium and Complex rigs have fewer or more nodes', () => {
    expect(templateNodes('human', 'low').length).toBe(6);
    expect(templateNodes('human', 'medium').length).toBe(10);
    expect(templateNodes('human').length).toBe(15);
    // A simple cat has no chest: the head moves with the hips.
    const cat = templateNodes('four', 'low');
    expect(cat.find((n) => n.id === 'neck')?.parent).toBe('pelvis');
    expect(cat.some((n) => n.id === 'tail')).toBe(false);
  });

  it('older rigs move as before', () => {
    const v = view({ head: 'head' });
    expect(skeletonOf(rig(v)).joints.length).toBe(14);
    expect(unlockedOf({ ...rig(v), level: 'low' }).has('elbow_L')).toBe(false);
  });
});
