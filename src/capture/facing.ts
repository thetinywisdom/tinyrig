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
  /** Shoulder width over torso height: about 0.7 facing you, 0.4 at 3/4, near 0 side-on. For tuning and display. */
  width: number;
  /** How far the body is turned from facing you, in degrees (0 facing you or away, 90 side-on), when depth was available. */
  turn?: number;
}

/** Turn, in degrees, at the thresholds between angles (from depth). */
export const QUARTER_FROM = 32, SIDE_FROM = 62;
/** A smaller turn still counts as 3/4 when the shoulders also look narrow. A raised arm alone turns the shoulders 20-30 degrees. */
export const QUARTER_WITH_NARROW = 20;
/** Without depth: how wide the shoulders look against the torso, at the same thresholds. */
export const FRONT_FROM = 0.5, SIDE_BELOW = 0.22;

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

  // How far the body is turned: the shoulders' depth difference against their width in the picture.
  const hasDepth = sL.z !== undefined && sR.z !== undefined;
  const yaw = hasDepth ? (Math.atan2(Math.abs(sL.z! - sR.z!), Math.abs(sL.x - sR.x)) * 180) / Math.PI : null;
  const band = yaw !== null ? (yaw >= SIDE_FROM ? 'side' : yaw >= QUARTER_FROM || (yaw >= QUARTER_WITH_NARROW && width < FRONT_FROM) ? 'turned' : 'square')
    : width < SIDE_BELOW ? 'side' : width < FRONT_FROM ? 'turned' : 'square';

  let view: ViewId;
  if (band === 'square') view = faceSeen || leftOnRight ? 'front' : 'back';
  else if (band === 'turned') view = faceSeen ? 'quarter' : 'back';
  else view = 'side';

  let looks: Facing['looks'] = null;
  if (view === 'quarter' || view === 'side') {
    // The nose points the way they look. When it is unclear, depth decides: looking toward the left of the
    // picture means having turned so the left shoulder is nearer the camera (smaller z), and the reverse.
    const byNose = Math.abs(turn) > 0.04 ? Math.sign(turn) : 0;
    const depth = hasDepth ? sL.z! - sR.z! : 0;
    const byDepth = Math.abs(depth) > 0.05 * torso ? Math.sign(depth) : 0;
    const dir = byNose || byDepth;
    looks = dir < 0 ? 'left' : dir > 0 ? 'right' : 'left';
  }
  if (opts.mirror && looks) looks = looks === 'left' ? 'right' : 'left';
  return { view, looks, width: Math.round(width * 100) / 100, turn: yaw === null ? undefined : Math.round(yaw) };
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
