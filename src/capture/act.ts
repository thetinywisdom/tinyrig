// From a photo's body points to a character's pose: the angle is read from the photo (3/4, side, back),
// the drawing is flipped to look the same way, then each part turns to match. Pure: no DOM.
import type { ActedPose } from '../model/act';
import { VIEWS, type ViewId } from '../model/skeleton';
import { unlockedOf } from '../model/rig';
import type { Rig } from '../model/types';
import { flipFor, nearestView, readFacing } from './facing';
import { landmarksToPose, type Landmark } from './mapping';

/** How far the neck and waist bend at most, in degrees, when the rig has no limit of its own. */
export const SPINE_LIMIT = 70;
/** Without hips in the picture the waist can only be guessed from the shoulders: a gentle lean at most. */
export const WAIST_LIMIT_NO_HIPS = 30;

export interface ActOptions {
  /** The photo's size in pixels. Points outside it are guesses for parts out of the picture, and are ignored. */
  size?: { w: number; h: number };
  /** Copy like a mirror, as the webcam shows you, rather than as the photo looks. */
  mirror?: boolean;
  /** Your own choices, kept when the dots move. */
  view?: ViewId;
  flip?: boolean;
  /** The pose before, so parts the photo could not see stay as they were. */
  current?: ActedPose;
}

export function poseFromPoints(allPoints: Landmark[], rig: Rig, opts: ActOptions = {}): ActedPose {
  const points = inPicture(allPoints, opts.size);
  const has = VIEWS.filter((v) => rig.views[v]);
  const facing = readFacing(points, { mirror: opts.mirror });
  const view = opts.view && rig.views[opts.view] ? opts.view : nearestView(facing?.view ?? 'front', has);
  const drawing = rig.views[view]!;
  const flip = opts.flip ?? (facing ? flipFor(facing, drawing.faces ?? 'left') : false);
  // A flipped drawing turns everything around, so the photo is read the other way round too.
  const mirror = !!opts.mirror !== flip;
  // Parts the photo cannot see keep the pose they had, even when the angle changes: angles fit any drawing.
  const current = opts.current?.angles ?? {};
  const result = landmarksToPose(points, drawing, unlockedOf(rig), current, { mirror, rootAngle: opts.current?.rootAngle ?? 0 });
  const angles = { ...current, ...result.angles };
  // A misread photo must not fold the character in half: the neck and waist bend at most this far
  // unless the rig sets its own limits. The dots stay where the tracker put them, so you can see and fix them.
  const hips = [23, 24].every((i) => (points[i]?.visibility ?? 0) >= 0.5);
  for (const j of ['neck', 'waist']) {
    const limit = j === 'waist' && !hips ? WAIST_LIMIT_NO_HIPS : SPINE_LIMIT;
    if (angles[j] !== undefined && !rig.limits[j]) angles[j] = Math.max(-limit, Math.min(limit, angles[j]));
  }
  return { view, flip, rootAngle: result.rootAngle ?? opts.current?.rootAngle ?? 0, angles, swaps: opts.current?.swaps };
}

/**
 * The tracker guesses where parts outside the photo would be. Those guesses are not seen: they are marked unseen,
 * so a photo from the waist up leaves the legs (and, without hips, the body's lean) as they were.
 */
export function inPicture(points: Landmark[], size?: { w: number; h: number }): Landmark[] {
  if (!size) return points;
  const mx = size.w * 0.02, my = size.h * 0.02;
  return points.map((p) => (p.x < -mx || p.y < -my || p.x > size.w + mx || p.y > size.h + my ? { ...p, visibility: 0 } : p));
}

/** Whether the photo shows the whole body, or only from the waist (or chest) up. */
export function bodyShown(points: Landmark[], size?: { w: number; h: number }): 'full' | 'half' {
  const seen = inPicture(points, size);
  const knees = [25, 26].filter((i) => (seen[i]?.visibility ?? 0) >= 0.5).length;
  const ankles = [27, 28].filter((i) => (seen[i]?.visibility ?? 0) >= 0.5).length;
  return knees + ankles >= 2 ? 'full' : 'half';
}

/** A standing figure for a photo the app could not read, so you can drag the dots into place yourself. */
export function standingPoints(w: number, h: number): Landmark[] {
  const pts: Landmark[] = Array.from({ length: 33 }, () => ({ x: w / 2, y: h / 2, visibility: 0 }));
  const cx = w / 2, top = h * 0.12, u = h * 0.76 / 8; // eight "heads" tall
  const set = (i: number, x: number, y: number) => { pts[i] = { x: cx + x * u, y: top + y * u, visibility: 1 }; };
  set(0, 0, 0.55); set(2, 0.15, 0.4); set(5, -0.15, 0.4); set(7, 0.4, 0.5); set(8, -0.4, 0.5);
  set(11, 0.9, 1.5); set(12, -0.9, 1.5); set(13, 1.05, 2.9); set(14, -1.05, 2.9); set(15, 1.1, 4.1); set(16, -1.1, 4.1);
  set(19, 1.12, 4.5); set(20, -1.12, 4.5); set(23, 0.55, 4); set(24, -0.55, 4);
  set(25, 0.6, 5.9); set(26, -0.6, 5.9); set(27, 0.6, 7.7); set(28, -0.6, 7.7);
  return pts;
}

/** The body points shown as dots you can drag, and the lines between them. "L" is the person's own left. */
export const DOTS: { i: number; name: string }[] = [
  { i: 0, name: 'nose' }, { i: 7, name: 'left ear' }, { i: 8, name: 'right ear' },
  { i: 11, name: 'left shoulder' }, { i: 12, name: 'right shoulder' }, { i: 13, name: 'left elbow' }, { i: 14, name: 'right elbow' },
  { i: 15, name: 'left wrist' }, { i: 16, name: 'right wrist' }, { i: 19, name: 'left hand' }, { i: 20, name: 'right hand' },
  { i: 23, name: 'left hip' }, { i: 24, name: 'right hip' }, { i: 25, name: 'left knee' }, { i: 26, name: 'right knee' },
  { i: 27, name: 'left ankle' }, { i: 28, name: 'right ankle' },
];
export const BONES: [number, number][] = [
  [7, 8], [11, 12], [11, 13], [13, 15], [15, 19], [12, 14], [14, 16], [16, 20], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];
