import { describe, expect, it } from 'vitest';
import { bodyShown, inPicture, poseFromPoints } from '../src/capture/act';
import { readFacing } from '../src/capture/facing';
import type { Landmark } from '../src/capture/mapping';
import type { Rig, RigView } from '../src/model/types';

// A front drawing standing straight: shoulders, elbows, wrists and legs hang down.
const view: RigView = {
  pieces: {}, rootPivot: { x: 300, y: 470 }, tips: { arm_L: { x: 386, y: 520 }, arm_R: { x: 214, y: 520 }, leg_L: { x: 336, y: 800 }, leg_R: { x: 264, y: 800 } },
  groupOrder: [],
  pivots: {
    neck: { x: 300, y: 232 }, waist: { x: 300, y: 446 },
    shoulder_L: { x: 362, y: 286 }, elbow_L: { x: 378, y: 392 }, wrist_L: { x: 386, y: 490 },
    shoulder_R: { x: 238, y: 286 }, elbow_R: { x: 222, y: 392 }, wrist_R: { x: 214, y: 490 },
    hip_L: { x: 330, y: 500 }, knee_L: { x: 334, y: 640 }, ankle_L: { x: 336, y: 770 },
    hip_R: { x: 270, y: 500 }, knee_R: { x: 266, y: 640 }, ankle_R: { x: 264, y: 770 },
  },
};
const rig = { version: 1, name: 't', level: 'high', views: { front: view }, limits: {} } as unknown as Rig;

/** A person from the waist up in a 640×480 webcam picture: the left arm raised to the side; hips and legs below the picture. */
function halfBody(): Landmark[] {
  const p: Landmark[] = Array.from({ length: 33 }, () => ({ x: 320, y: 900, visibility: 0.6 }));
  const at = (i: number, x: number, y: number, v = 0.99) => { p[i] = { x, y, visibility: v }; };
  at(0, 320, 120); at(2, 335, 108); at(5, 305, 108); at(7, 350, 115); at(8, 290, 115);
  at(11, 400, 230); at(12, 240, 230);
  at(13, 500, 230); at(15, 600, 225); at(19, 625, 225); // left arm straight out to the side
  at(14, 220, 340); at(16, 210, 440); at(20, 208, 465);
  // The tracker still guesses hips, knees and ankles below the picture, some with fair confidence.
  at(23, 380, 560, 0.7); at(24, 260, 560, 0.7); at(25, 382, 760, 0.6); at(26, 258, 760, 0.6); at(27, 384, 940, 0.5); at(28, 256, 940, 0.5);
  return p;
}
const size = { w: 640, h: 480 };

describe('a photo from the waist up', () => {
  it('is recognised as half a body', () => {
    expect(bodyShown(halfBody(), size)).toBe('half');
  });
  it('ignores the guesses for parts outside the picture', () => {
    const seen = inPicture(halfBody(), size);
    expect(seen[25].visibility).toBe(0);
    expect(seen[11].visibility).toBeGreaterThan(0.9);
  });
  it('arms follow; legs and the lean keep their pose', () => {
    const current = { view: 'front' as const, flip: false, rootAngle: 4, angles: { knee_L: -30, hip_R: 15 } };
    const pose = poseFromPoints(halfBody(), rig, { size, current });
    expect(Math.abs(pose.angles.shoulder_L)).toBeGreaterThan(60); // raised to the side
    expect(pose.angles.knee_L).toBe(-30);
    expect(pose.angles.hip_R).toBe(15);
    expect(pose.rootAngle).toBe(4);
  });
  it('still reads the angle from the shoulders and head', () => {
    expect(readFacing(inPicture(halfBody(), size))?.view).toBe('front');
  });
});

describe('without hips in the picture', () => {
  it('the waist only leans gently, however the shoulders read', () => {
    const pts = halfBody();
    pts[12] = { x: 300, y: 300, visibility: 0.99 }; // a badly misread right shoulder: the shoulder line tips steeply
    const pose = poseFromPoints(pts, rig, { size });
    expect(Math.abs(pose.angles.waist ?? 0)).toBeLessThanOrEqual(30);
  });
});
