import { describe, expect, it } from 'vitest';
import { landmarksToPose, type Landmark } from '../src/capture/mapping';
import { drawList, restPose, swapOptions } from '../src/model/pose';
import { unlockedJoints } from '../src/model/skeleton';
import { cameraRect, defaultCameras, evaluate, flapsFromVolume, FORMATS, newShot, setKey, setMouthKey, toSrt, type Actor } from '../src/model/shot';
import type { Pose, RigPiece, RigView } from '../src/model/types';

const pose = (angles: Record<string, number>, x = 0): Pose => ({ view: 'front', flip: false, root: { x, y: 0 }, rootAngle: 0, angles });
const actor = (): Actor => ({ id: 'a', character: 'c', role: 'actor', base: pose({ neck: 5 }), keys: [], mouth: [] });

describe('timeline', () => {
  it('shows the resting pose until there are keys', () => {
    expect(evaluate(newShot('s'), actor(), 10).angles.neck).toBe(5);
  });
  it('blends between keys, the short way round, and steps what cannot blend', () => {
    const shot = newShot('s'), a = actor();
    setKey(a, 0, { ...pose({ elbow_L: 170 }, 0), swaps: { hand_L: 'fist' } }, 'linear');
    setKey(a, 10, { ...pose({ elbow_L: -170 }, 100), flip: true });
    const mid = evaluate(shot, a, 5);
    expect(Math.abs(mid.angles.elbow_L)).toBeCloseTo(180);
    expect(mid.root.x).toBeCloseTo(50);
    expect(mid.flip).toBe(false);
    expect(mid.swaps).toEqual({ hand_L: 'fist' });
    expect(evaluate(shot, a, 10).flip).toBe(true);
    expect(evaluate(shot, a, 50).root.x).toBe(100);
  });
  it('holds drawings on twos and threes, with overrides per character and per frame range', () => {
    const shot = newShot('s'), a = actor();
    setKey(a, 0, pose({}, 0), 'linear');
    setKey(a, 12, pose({}, 120));
    expect(evaluate(shot, a, 5).root.x).toBeCloseTo(50);
    shot.timing = 2;
    expect(evaluate(shot, a, 5).root.x).toBeCloseTo(40);
    a.timing = 3;
    expect(evaluate(shot, a, 5).root.x).toBeCloseTo(30);
    shot.timingRanges.push({ from: 4, to: 8, timing: 1 });
    expect(evaluate(shot, a, 5).root.x).toBeCloseTo(50);
  });
  it('an extra never animates', () => {
    const a = { ...actor(), role: 'extra' as const };
    setKey(a, 0, pose({ neck: 90 }));
    expect(evaluate(newShot('s'), a, 0).angles.neck).toBe(5);
  });
  it('mouth keys sit on top of the pose and step', () => {
    const shot = newShot('s'), a = actor();
    setMouthKey(a, 4, 'a'); setMouthKey(a, 8, 'rest'); setMouthKey(a, 4, 'o');
    expect(evaluate(shot, a, 2).swaps).toBeUndefined();
    expect(evaluate(shot, a, 6).swaps).toEqual({ mouth: 'o' });
    expect(evaluate(shot, a, 9).swaps).toEqual({ mouth: 'rest' });
  });
  it('makes mouth flaps from loudness and closes the mouth at the end', () => {
    const vol = [0, 0, 0.2, 0.9, 1, 0.5, 0.1, 0, 0, 0.6, 0.6];
    const keys = flapsFromVolume(vol, 10, ['rest', 'a', 'e', 'o'], 1);
    expect(keys[0]).toEqual({ frame: 10, shape: 'rest' });
    expect(keys.find((k) => k.frame === 13)?.shape).toBe('o');
    expect(keys[keys.length - 1]).toEqual({ frame: 21, shape: 'rest' });
    expect(flapsFromVolume([0, 0], 0, ['rest', 'a'], 1)).toEqual([]);
  });
  it('writes subtitles as srt, in order, skipping on-screen text', () => {
    const shot = newShot('s');
    shot.texts.push({ id: '2', kind: 'subtitle', text: 'Second', start: 48, end: 72, x: 0, y: 0, size: 1, color: '' });
    shot.texts.push({ id: 't', kind: 'text', text: 'POW', start: 0, end: 9, x: 0, y: 0, size: 1, color: '' });
    shot.texts.push({ id: '1', kind: 'subtitle', text: 'First', start: 0, end: 36, x: 0, y: 0, size: 1, color: '' });
    expect(toSrt(shot)).toBe('1\n00:00:00,000 --> 00:00:01,500\nFirst\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond\n');
  });
  it('gives every output shape a framing inside the stage, none above 1920 x 1080', () => {
    const shot = newShot('s');
    for (const f of FORMATS) {
      expect(Math.max(f.w, f.h)).toBeLessThanOrEqual(1920);
      const r = cameraRect(defaultCameras(shot.stage)[f.id], f);
      expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(shot.stage.w); expect(r.y + r.h).toBeLessThanOrEqual(shot.stage.h);
      expect(r.w / r.h).toBeCloseTo(f.w / f.h);
    }
  });
});

const piece = (bone: string, group: string, z: number, more: Partial<RigPiece> = {}): RigPiece => ({ bone, group, z, scale: 1, bbox: { x: 0, y: 0, w: 1, h: 1 }, ...more });
const view: RigView = {
  rootPivot: { x: 100, y: 300 }, groupOrder: ['torso', 'head', 'arm_L'], tips: { arm_L: { x: 160, y: 300 }, arm_R: { x: 40, y: 300 } },
  pivots: {
    neck: { x: 100, y: 100 }, shoulder_L: { x: 140, y: 110 }, elbow_L: { x: 150, y: 200 }, wrist_L: { x: 160, y: 300 },
    shoulder_R: { x: 60, y: 110 }, elbow_R: { x: 50, y: 200 }, wrist_R: { x: 40, y: 300 }, hip_L: { x: 120, y: 300 }, hip_R: { x: 80, y: 300 },
    knee_L: { x: 120, y: 400 }, knee_R: { x: 80, y: 400 }, ankle_L: { x: 120, y: 500 }, ankle_R: { x: 80, y: 500 }, waist: { x: 100, y: 250 },
  },
  pieces: {
    chest: piece('chest', 'torso', 1), head: piece('head', 'head', 2),
    forearm_L: piece('forearm_L', 'arm_L', 3), hand_L: piece('hand_L', 'arm_L', 4), upperarm_L: piece('upperarm_L', 'arm_L', 5),
    forearm_L_bent: piece('forearm_L', 'arm_L', 9, { slot: 'forearm_L', variant: 'bent' }),
    mouth_rest: piece('head', 'head', 6, { slot: 'mouth', variant: 'rest', overlay: true }),
    mouth_a: piece('head', 'head', 7, { slot: 'mouth', variant: 'a', overlay: true }),
    hand_fist: piece('hand_L', 'arm_L', 8, { slot: 'hand', variant: 'fist', shared: 'hand', anchor: { x: 500, y: 20 } }),
  },
};

describe('swaps', () => {
  it('lists what each slot can show', () => {
    expect(swapOptions(view)).toEqual({ forearm_L: ['bent'], mouth: ['rest', 'a'], hand_L: ['fist'], hand_R: ['fist'] });
  });
  it('draws lines first then fills per group, with the default mouth on top of the head', () => {
    const list = drawList(view, restPose(view, 'front')).map((d) => `${d.piece}:${d.pass}`);
    expect(list).toEqual(['chest:line', 'chest:fill', 'head:line', 'head:fill', 'mouth_rest:whole',
      'forearm_L:line', 'hand_L:line', 'upperarm_L:line', 'forearm_L:fill', 'hand_L:fill', 'upperarm_L:fill']);
  });
  it('swaps a piece in place, a mouth, and a shared hand onto the wrist', () => {
    const p = { ...restPose(view, 'front'), swaps: { forearm_L: 'bent', mouth: 'a', hand_L: 'fist' } };
    const list = drawList(view, p);
    expect(list.map((d) => d.piece)).toContain('forearm_L_bent');
    expect(list.map((d) => d.piece)).not.toContain('forearm_L');
    expect(list.map((d) => d.piece)).toContain('mouth_a');
    const hand = list.find((d) => d.piece === 'hand_fist')!;
    expect(hand.bone).toBe('hand_L');
    // The wrist point of the shared art lands on the character's wrist.
    const m = hand.xf!;
    expect(m[0] * 500 + m[2] * 20 + m[4]).toBeCloseTo(160);
    expect(m[1] * 500 + m[3] * 20 + m[5]).toBeCloseTo(300);
  });
});

describe('capture', () => {
  const body = (over: Record<number, [number, number]>): Landmark[] => {
    const pts: Record<number, [number, number]> = {
      7: [110, 60], 8: [90, 60], 11: [140, 110], 12: [60, 110], 13: [150, 200], 14: [50, 200], 15: [160, 300], 16: [40, 300],
      19: [162, 320], 20: [38, 320], 23: [120, 300], 24: [80, 300], 25: [120, 400], 26: [80, 400], 27: [120, 500], 28: [80, 500], ...over,
    };
    return Array.from({ length: 33 }, (_, i) => ({ x: pts[i]?.[0] ?? 0, y: pts[i]?.[1] ?? 0, visibility: pts[i] ? 1 : 0 }));
  };
  const high = unlockedJoints('high');
  it('someone standing like the rest pose gives no rotation', () => {
    const r = landmarksToPose(body({}), view, high, {});
    expect(r.rootAngle).toBeCloseTo(0);
    for (const a of Object.values(r.angles)) expect(Math.abs(a)).toBeLessThan(1);
  });
  it('a raised left arm turns only that shoulder', () => {
    // Person's left arm straight out to the image right, forearm continuing.
    const r = landmarksToPose(body({ 13: [240, 110], 15: [340, 110], 19: [360, 110] }), view, high, {});
    expect(r.angles.shoulder_L).toBeCloseTo(-83.7, 0);
    expect(r.angles.shoulder_L + r.angles.elbow_L).toBeCloseTo(-84.3, 0);
    expect(Math.abs(r.angles.shoulder_R)).toBeLessThan(1);
  });
  it('mirror makes the other arm copy it', () => {
    const r = landmarksToPose(body({ 13: [240, 110], 15: [340, 110], 19: [360, 110] }), view, high, {}, { mirror: true });
    expect(r.angles.shoulder_R).toBeCloseTo(83.7, 0);
    expect(Math.abs(r.angles.shoulder_L)).toBeLessThan(1);
  });
  it('leaves locked and unseen parts alone', () => {
    const pts = body({ 13: [240, 110], 15: [340, 110] });
    pts[26].visibility = 0.1;
    const r = landmarksToPose(pts, view, high, { knee_R: 33 }, { locked: new Set(['arm_L']) });
    expect(r.angles.shoulder_L).toBeUndefined();
    expect(r.angles.hip_R).toBeUndefined();
  });
  it('a low rig swings the whole arm from shoulder to wrist', () => {
    const r = landmarksToPose(body({ 13: [240, 110], 15: [340, 110] }), view, unlockedJoints('low'), {});
    expect(r.angles.elbow_L).toBeUndefined();
    expect(r.angles.shoulder_L).toBeLessThan(-70);
  });
});
