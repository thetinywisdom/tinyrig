// Which way a person stands in a photo: front, 3/4, side or back, and which way they look.
// Pure maths on the tracked body points, so the app can pick the character's matching drawing.
import type { ViewId } from '../model/skeleton';
import type { Landmark } from './mapping';

/** MediaPipe pose indices used here. "L" is the person's own left. */
const NOSE = 0, EYE_L = 2, EYE_R = 5, SHOULDER_L = 11, SHOULDER_R = 12, HIP_L = 23, HIP_R = 24;

export interface Facing {
  view: ViewId;
  /** Which way the person looks, as you see the picture. Null when they face you or face away. */
  looks: 'left' | 'right' | null;
  /** Shoulder width over torso height: about 0.8 facing you, 0.4 at 3/4, near 0 side-on. For tuning and display. */
  width: number;
}

/** How wide the shoulders look against the torso, at the thresholds between angles. */
export const FRONT_FROM = 0.58, SIDE_BELOW = 0.26;

/**
 * Read the angle from body points in image pixels. With `mirror`, left and right are swapped, so the character
 * copies the person like a mirror.
 */
export function readFacing(points: Landmark[], opts: { mirror?: boolean; minVisibility?: number } = {}): Facing | null {
  const min = opts.minVisibility ?? 0.5;
  const p = (i: number) => points[i];
  const sL = p(SHOULDER_L), sR = p(SHOULDER_R), hL = p(HIP_L), hR = p(HIP_R);
  if (!sL || !sR || sL.visibility < min * 0.6 || sR.visibility < min * 0.6) return null;
  const sx = (sL.x + sR.x) / 2, sy = (sL.y + sR.y) / 2;
  const hips = hL && hR && Math.min(hL.visibility, hR.visibility) >= min * 0.6;
  // Torso height: shoulders to hips, or (seated, legs hidden) estimated from the head.
  const torso = hips ? Math.hypot((hL.x + hR.x) / 2 - sx, (hL.y + hR.y) / 2 - sy)
    : p(NOSE) ? Math.abs(sy - p(NOSE).y) * 2.6 : 0;
  if (torso < 1) return null;
  const width = Math.abs(sL.x - sR.x) / torso;

  const nose = p(NOSE), eyes = [p(EYE_L), p(EYE_R)].filter((e) => e && e.visibility >= min).length;
  const faceSeen = !!nose && nose.visibility >= min && eyes >= 1;
  // Facing you, the person's left shoulder is on the right of the picture. Facing away, it is on the left.
  const leftOnRight = sL.x > sR.x;
  // Where the nose sits against the middle of the shoulders says which way the head and body turn.
  const turn = nose ? (nose.x - sx) / torso : 0;

  let view: ViewId;
  if (width >= FRONT_FROM) view = faceSeen || leftOnRight ? 'front' : 'back';
  else if (width >= SIDE_BELOW) view = faceSeen ? 'quarter' : 'back';
  else view = 'side';
  if (view === 'back' && width < FRONT_FROM && faceSeen) view = 'quarter';

  let looks: Facing['looks'] = null;
  if (view === 'quarter' || view === 'side') {
    // The nose points the way they look. When it is unclear, depth decides: looking toward the left of the
    // picture means having turned so the left shoulder is nearer the camera (smaller z), and the reverse.
    const byNose = Math.abs(turn) > 0.04 ? Math.sign(turn) : 0;
    const depth = sL.z !== undefined && sR.z !== undefined ? sL.z - sR.z : 0;
    const byDepth = Math.abs(depth) > 0.02 ? Math.sign(depth) : 0;
    const dir = byNose || byDepth;
    looks = dir < 0 ? 'left' : dir > 0 ? 'right' : 'left';
  }
  if (opts.mirror && looks) looks = looks === 'left' ? 'right' : 'left';
  return { view, looks, width: Math.round(width * 100) / 100 };
}

/** Whether a drawing must be flipped to look the way the person looks. */
export function flipFor(facing: Facing, drawingFaces: 'left' | 'right' = 'left'): boolean {
  return !!facing.looks && facing.looks !== drawingFaces;
}

/**
 * The angle to draw: the one read from the photo if the character has it, else the nearest it has
 * (3/4 falls back to front, then side).
 */
export function nearestView(want: ViewId, has: ViewId[]): ViewId {
  const order: Record<ViewId, ViewId[]> = {
    front: ['front', 'quarter', 'side', 'back'], quarter: ['quarter', 'front', 'side', 'back'],
    side: ['side', 'quarter', 'front', 'back'], back: ['back', 'front', 'quarter', 'side'],
  };
  return order[want].find((v) => has.includes(v)) ?? has[0] ?? want;
}
