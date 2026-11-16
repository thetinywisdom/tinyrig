// Turns tracked body points (from a photo or webcam) into joint angles.
// Pure maths: every angle is the tracked direction of a body part minus the
// direction that part has in the character's rest pose.
import { canBend, normDeg } from '../model/pose';
import { JOINTS, type JointId } from '../model/skeleton';
import type { Pt, RigView } from '../model/types';

/** A tracked point in image pixels, with how sure the tracker is that it can see it (0..1). */
export interface Landmark { x: number; y: number; visibility: number; /** Depth from the tracker, in about the same pixels as x: smaller is nearer the camera. */ z?: number }

/** Indices in the MediaPipe pose model. "Left" is the person's own left. */
const P = {
  earL: 7, earR: 8, shoulderL: 11, shoulderR: 12, elbowL: 13, elbowR: 14, wristL: 15, wristR: 16,
  indexL: 19, indexR: 20, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankleL: 27, ankleR: 28,
};

export type CaptureGroup = 'head' | 'torso' | 'arm_L' | 'arm_R' | 'leg_L' | 'leg_R';
export const CAPTURE_GROUPS: [CaptureGroup, string][] = [['head', 'Head'], ['torso', 'Torso'], ['arm_L', 'Arm left'], ['arm_R', 'Arm right'], ['leg_L', 'Leg left'], ['leg_R', 'Leg right']];
const GROUP_OF = (joint: JointId): CaptureGroup =>
  joint === 'neck' ? 'head' : joint === 'waist' ? 'torso' : /^(shoulder|elbow|wrist)/.test(joint) ? (`arm_${joint.slice(-1)}` as CaptureGroup) : (`leg_${joint.slice(-1)}` as CaptureGroup);

const dir = (a: Pt, b: Pt) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

export interface CaptureResult { rootAngle: number | null; angles: Record<JointId, number>; seen: number }

/**
 * @param mirror  false: the person's left drives the character's left (as in a photo of someone facing you).
 *                true: the character copies you like a mirror.
 * @param locked  body parts to leave as they are.
 */
export function landmarksToPose(
  points: Landmark[], view: RigView, unlocked: Set<JointId>, current: Record<JointId, number>,
  opts: { mirror?: boolean; locked?: Set<CaptureGroup>; minVisibility?: number; /** The body's lean to keep when the hips cannot be seen. */ rootAngle?: number } = {},
): CaptureResult {
  const min = opts.minVisibility ?? 0.5;
  const at = (name: keyof typeof P): Landmark | null => {
    let key = name;
    if (opts.mirror) key = (name.endsWith('L') ? name.slice(0, -1) + 'R' : name.slice(0, -1) + 'L') as keyof typeof P;
    const p = points[P[key]];
    if (!p || p.visibility < min) return null;
    return opts.mirror ? { ...p, x: -p.x } : p;
  };
  const tracked = (a: keyof typeof P, b: keyof typeof P) => { const p = at(a), q = at(b); return p && q ? dir(p, q) : null; };
  const rest = (a?: Pt, b?: Pt) => (a && b ? dir(a, b) : null);
  const piv = view.pivots;

  // World angle of each bone: tracked direction minus rest direction. Lines across the body (hips,
  // shoulders, ears) are steadier than the spine for the pelvis, chest and head.
  const world: Record<string, number | null> = {};
  const turn = (t: number | null, r: number | null) => (t === null || r === null ? null : normDeg(t - r));
  world.pelvis = turn(tracked('hipR', 'hipL'), rest(piv.hip_R, piv.hip_L));
  world.chest = turn(tracked('shoulderR', 'shoulderL'), rest(piv.shoulder_R, piv.shoulder_L));
  world.head = turn(tracked('earR', 'earL'), 0);
  for (const s of ['L', 'R'] as const) {
    const tipArm = piv[`wrist_${s}`] ?? view.tips[`arm_${s}`], tipLeg = piv[`ankle_${s}`] ?? view.tips[`leg_${s}`];
    world[`upperarm_${s}`] = turn(tracked(`shoulder${s}`, `elbow${s}`), rest(piv[`shoulder_${s}`], piv[`elbow_${s}`] ?? tipArm));
    world[`forearm_${s}`] = turn(tracked(`elbow${s}`, `wrist${s}`), rest(piv[`elbow_${s}`], tipArm));
    // At rest a hand continues the line of its forearm.
    world[`hand_${s}`] = turn(tracked(`wrist${s}`, `index${s}`), rest(piv[`elbow_${s}`], piv[`wrist_${s}`]));
    world[`thigh_${s}`] = turn(tracked(`hip${s}`, `knee${s}`), rest(piv[`hip_${s}`], piv[`knee_${s}`] ?? tipLeg));
    world[`shin_${s}`] = turn(tracked(`knee${s}`, `ankle${s}`), rest(piv[`knee_${s}`], tipLeg));
    world[`foot_${s}`] = null; // feet are too small to track reliably: left as posed
  }
  // A low rig has no elbow: the whole arm follows shoulder to wrist instead.
  for (const s of ['L', 'R'] as const) {
    if (!canBend(view, unlocked, `elbow_${s}`)) world[`upperarm_${s}`] = turn(tracked(`shoulder${s}`, `wrist${s}`), rest(piv[`shoulder_${s}`], view.tips[`arm_${s}`] ?? piv[`wrist_${s}`])) ?? world[`upperarm_${s}`];
    if (!canBend(view, unlocked, `knee_${s}`)) world[`thigh_${s}`] = turn(tracked(`hip${s}`, `ankle${s}`), rest(piv[`hip_${s}`], view.tips[`leg_${s}`] ?? piv[`ankle_${s}`])) ?? world[`thigh_${s}`];
  }

  const angles: Record<JointId, number> = {};
  const torsoLocked = opts.locked?.has('torso');
  const rootAngle = torsoLocked ? null : world.pelvis;
  // Each joint's own angle is its bone's world angle minus its parent's. An unseen or locked part keeps its current angle.
  // Hips out of sight (a photo from the waist up): the body keeps its lean, and the chest turns from there.
  const resolved: Record<string, number> = { pelvis: world.pelvis ?? opts.rootAngle ?? 0 };
  let seen = world.pelvis === null ? 0 : 1;
  for (const j of JOINTS) {
    const parent = resolved[j.parent] ?? 0;
    const w = world[j.bone];
    if (!canBend(view, unlocked, j.id)) { resolved[j.bone] = parent; continue; }
    if (w === null || w === undefined || opts.locked?.has(GROUP_OF(j.id))) { resolved[j.bone] = parent + (current[j.id] ?? 0); continue; }
    angles[j.id] = Math.round(normDeg(w - parent) * 10) / 10;
    resolved[j.bone] = w;
    seen++;
  }
  return { rootAngle, angles, seen };
}
