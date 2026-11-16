import { describe, expect, it } from 'vitest';
import { cameraAt, compileScene, DEFAULT_SIZE, laneTimes, resizeCamera, sceneSeconds, stackOf, upgradeScene, type SceneData } from '../src/model/scene';

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
