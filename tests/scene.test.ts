import { describe, expect, it } from 'vitest';
import { BLEND, cameraAt, compileScene, DEFAULT_SIZE, laneTimes, resizeCamera, sceneSeconds, spliceTake, stackOf, takeToPoses, upgradeScene, type SceneData } from '../src/model/scene';

const pose = (a = 0) => ({ view: 'front' as const, flip: false, rootAngle: 0, angles: { elbow_L: a } });
const cast = [{ id: 'm', character: 'Momo', root: { x: 0, y: 0 }, scale: 1 }, { id: 'c', character: 'Cat', root: { x: 0, y: 0 }, scale: 1 }];

describe('scenes', () => {
  it('moves an older acted panel onto one lane per character', () => {
    const old = {
      cast,
      moments: [
        { id: '1', hold: 0.5, move: 0.5, photo: 'a.jpg', actor: 'm', poses: { m: pose(10), c: pose(1) } },
        { id: '2', hold: 1, move: 0.5, poses: { m: pose(20) } },
      ],
      background: { file: 'sky.png', x: 0, y: 0, scale: 1 },
    } as SceneData & Record<string, unknown>;
    upgradeScene(old);
    expect(old.moments).toBeUndefined();
    expect(old.lanes!.m.poses.map((p) => p.pose.angles.elbow_L)).toEqual([10, 20]);
    expect(old.lanes!.m.poses[0].photo).toBe('a.jpg');
    // The cat keeps its last pose where it had none, and the photo stays with the character it drove.
    expect(old.lanes!.c.poses.map((p) => p.pose.angles.elbow_L)).toEqual([1, 1]);
    expect(old.lanes!.c.poses[0].photo).toBeUndefined();
    expect(old.images).toEqual([{ id: 'background', file: 'sky.png', x: 0, y: 0, scale: 1 }]);
  });

  it('times each lane on its own, and the scene runs to the last thing in it', () => {
    const s: SceneData = { cast, lanes: {
      m: { start: 0, poses: [{ id: 'a', hold: 0.5, move: 0.5, pose: pose() }, { id: 'b', hold: 1, move: 0.5, pose: pose() }] },
      c: { start: 0.7, poses: [{ id: 'x', hold: 0.6, move: 0.5, pose: pose() }] },
    } };
    expect(laneTimes(s.lanes!.m)).toEqual([{ start: 0, holdEnd: 0.5, end: 1 }, { start: 1, holdEnd: 2, end: 2 }]);
    expect(laneTimes(s.lanes!.c)[0].start).toBe(0.7);
    expect(sceneSeconds(s)).toBe(2);
    s.camera = [{ id: 'k', t: 3, x: 0, y: 0, width: 100, arrive: 'move', curve: 'linear' }];
    expect(sceneSeconds(s)).toBe(3);
  });

  it('moves the camera between keys, or cuts', () => {
    const s: SceneData = { camera: [
      { id: '1', t: 0, x: 0, y: 0, width: 100, arrive: 'move', curve: 'linear' },
      { id: '2', t: 2, x: 100, y: 0, width: 50, arrive: 'move', curve: 'linear' },
      { id: '3', t: 4, x: 500, y: 0, width: 50, arrive: 'cut', curve: 'smooth' },
    ] };
    expect(cameraAt(s, DEFAULT_SIZE, 1)).toEqual({ x: 50, y: 0, width: 75 });
    expect(cameraAt(s, DEFAULT_SIZE, 3.9).x).toBe(100); // holds until the cut
    expect(cameraAt(s, DEFAULT_SIZE, 4).x).toBe(500);
    expect(cameraAt(s, DEFAULT_SIZE, 9).x).toBe(500);
  });

  it('a new size keeps how much of the canvas each frame covers', () => {
    const s: SceneData = { camera: [{ id: '1', t: 0, x: 0, y: 0, width: 1920, arrive: 'move', curve: 'linear' }] };
    resizeCamera(s, DEFAULT_SIZE, { id: 'reels', w: 1080, h: 1920 });
    const w = s.camera![0].width;
    expect(Math.round(w * ((w * 1920) / 1080))).toBe(1920 * 1080);
  });

  it('stacks everything once, front to back, and draws back to front', () => {
    const s: SceneData = { cast, images: [{ id: 'sky', file: 'sky.png', x: 0, y: 0, scale: 1 }, { id: 'leaves', file: 'l.png', x: 0, y: 0, scale: 1 }],
      stack: [{ kind: 'image', id: 'leaves' }, { kind: 'cast', id: 'm' }] };
    expect(stackOf(s).map((e) => e.id)).toEqual(['c', 'leaves', 'm', 'sky']);
    const shot = compileScene('s', s, DEFAULT_SIZE);
    expect(shot.order).toEqual(['sky', 'm', 'leaves', 'c']);
    expect(Object.keys(shot.cameras)).toEqual(['size-1920x1080']);
  });
});

describe('recording', () => {
  const at = (deg: number) => ({ view: 'front' as const, flip: false, rootAngle: 0, angles: { elbow_L: deg } });
  let n = 0;
  const id = () => `p${++n}`;
  // An elbow that bends from 0 to 90 over a second, holds still for a second, then straightens.
  const samples = Array.from({ length: 61 }, (_, i) => {
    const t = i / 20;
    const deg = t < 1 ? t * 90 : t < 2 ? 90 : Math.max(0, 90 - (t - 2) * 90);
    return { t, pose: at(deg) };
  });

  it('keeps the key poses of a take, holding where you held still', () => {
    const out = takeToPoses(samples, { id, tolerance: 12 });
    const degs = out.map((x) => Math.round(x.lp.pose.angles.elbow_L));
    expect(degs[0]).toBe(0);
    expect(degs.some((d) => d > 80)).toBe(true);
    expect(degs.at(-1)).toBeLessThan(10);
    expect(out.length).toBeLessThan(8); // not every frame
    const still = out.find((x) => x.lp.pose.angles.elbow_L > 80)!;
    expect(still.lp.hold).toBeGreaterThan(0.7); // the second you held still
  });

  it('or keeps every frame in one block', () => {
    const out = takeToPoses(samples, { id, everyFrame: true });
    expect(out).toHaveLength(1);
    expect(out[0].lp.frames).toHaveLength(61);
    expect(out[0].lp.hold).toBe(3);
  });

  it('a take replaces what it covers and moves in and out of the poses around it', () => {
    const lane = { start: 0, poses: [
      { id: 'a', hold: 1, move: 0.5, pose: at(1) }, { id: 'b', hold: 1, move: 0.5, pose: at(2) },
      { id: 'c', hold: 1, move: 0.5, pose: at(3) }, { id: 'd', hold: 1, move: 0.5, pose: at(4) },
    ] }; // starts 0, 1.5, 3, 4.5
    spliceTake(lane, 1.2, [{ start: 0, lp: { id: 'x', hold: 0.5, move: 0.5, pose: at(50) } }, { start: 1, lp: { id: 'y', hold: 0.5, move: 0.5, pose: at(60) } }]);
    expect(lane.poses.map((p) => p.id)).toEqual(['a', 'x', 'y', 'c', 'd']);
    const t = laneTimes(lane);
    expect(t[0].holdEnd).toBeCloseTo(0.95); // a stops holding in time to move into the take
    expect(t[1].start).toBeCloseTo(1.2);
    expect(t[3].start - t[2].holdEnd).toBeGreaterThanOrEqual(BLEND - 1e-9); // and c is reached by a move, not a cut
    expect(t[3].start).toBeCloseTo(3);
  });
});
