// From a photo's body points to a character's pose: the angle is read from the photo (3/4, side, back),
// the drawing is flipped to look the same way, then each part turns to match. Pure: no DOM.
import type { ActedPose } from '../model/act';
import { unlockedJoints, VIEWS, type ViewId } from '../model/skeleton';
import type { Rig } from '../model/types';
import { flipFor, nearestView, readFacing } from './facing';
import { landmarksToPose, type Landmark } from './mapping';

/** How far the neck and waist bend at most, in degrees, when the rig has no limit of its own. */
export const SPINE_LIMIT = 70;

export interface ActOptions {
  /** Copy like a mirror, as the webcam shows you, rather than as the photo looks. */
  mirror?: boolean;
  /** Your own choices, kept when the dots move. */
  view?: ViewId;
  flip?: boolean;
  /** The pose before, so parts the photo could not see stay as they were. */
  current?: ActedPose;
}

export function poseFromPoints(points: Landmark[], rig: Rig, opts: ActOptions = {}): ActedPose {
  const has = VIEWS.filter((v) => rig.views[v]);
  const facing = readFacing(points, { mirror: opts.mirror });
  const view = opts.view && rig.views[opts.view] ? opts.view : nearestView(facing?.view ?? 'front', has);
  const drawing = rig.views[view]!;
  const flip = opts.flip ?? (facing ? flipFor(facing, drawing.faces ?? 'left') : false);
  // A flipped drawing turns everything around, so the photo is read the other way round too.
  const mirror = !!opts.mirror !== flip;
  const current = opts.current?.view === view ? opts.current.angles : {};
  const result = landmarksToPose(points, drawing, unlockedJoints(rig.level), current, { mirror });
  const angles = { ...current, ...result.angles };
  // A misread photo must not fold the character in half: the neck and waist bend at most this far
  // unless the rig sets its own limits. The dots stay where the tracker put them, so you can see and fix them.
  for (const j of ['neck', 'waist']) {
    if (angles[j] !== undefined && !rig.limits[j]) angles[j] = Math.max(-SPINE_LIMIT, Math.min(SPINE_LIMIT, angles[j]));
  }
  return { view, flip, rootAngle: result.rootAngle ?? 0, angles, swaps: opts.current?.swaps };
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
