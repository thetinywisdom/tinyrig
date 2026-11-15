// Pure pose maths: bone matrices (FK) and the 2-bone IK solver. No DOM, no Pixi.
import { JOINTS, JOINT_BY_ID, OVERLAY_SLOTS, ROOT_BONE, type BoneId, type JointId, type LimbDef } from './skeleton';
import type { Pose, Pt, Rig, RigView } from './types';

/** 2D affine: x' = a·x + c·y + e, y' = b·x + d·y + f */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const DEG = Math.PI / 180;

/** m ∘ n: apply n first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scale = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
export function rotate(deg: number): Mat {
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return [c, s, -s, c, 0, 0];
}
export function rotateAbout(p: Pt, deg: number): Mat {
  return mul(translate(p.x, p.y), mul(rotate(deg), translate(-p.x, -p.y)));
}
export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
export function apply(m: Mat, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** Wrap to (-180, 180]. */
export function normDeg(a: number): number {
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return a === -180 ? 180 : a;
}
export function clampToLimit(a: number, limit?: [number, number]): number {
  a = normDeg(a);
  if (!limit) return a;
  return Math.min(limit[1], Math.max(limit[0], a));
}

/** A joint bends only if its level unlocks it and the view has a pivot for it. */
export function canBend(view: RigView, unlocked: Set<JointId>, joint: JointId): boolean {
  return unlocked.has(joint) && !!view.pivots[joint];
}

export function rootMatrix(view: RigView, pose: Pose): Mat {
  return mul(
    translate(pose.root.x, pose.root.y),
    mul(rotate(pose.rootAngle), mul(scale((pose.flip ? -1 : 1) * (pose.scale ?? 1), pose.scale ?? 1), translate(-view.rootPivot.x, -view.rootPivot.y))),
  );
}

/** World matrix per bone. Rest-pose stage coordinates go in, world coordinates come out. */
export function boneMatrices(view: RigView, pose: Pose, unlocked: Set<JointId>): Record<BoneId, Mat> {
  const out: Record<BoneId, Mat> = { [ROOT_BONE]: rootMatrix(view, pose) };
  for (const j of JOINTS) {
    const parent = out[j.parent];
    const pivot = view.pivots[j.id];
    const angle = pivot && unlocked.has(j.id) ? pose.angles[j.id] ?? 0 : 0;
    out[j.bone] = pivot && angle ? mul(parent, rotateAbout(pivot, angle)) : parent;
  }
  return out;
}

export function restPose(view: RigView, viewId: Pose['view'], root?: Pt): Pose {
  return { view: viewId, flip: false, root: root ?? { ...view.rootPivot }, rootAngle: 0, angles: {} };
}

const ang = (from: Pt, to: Pt) => Math.atan2(to.y - from.y, to.x - from.x) / DEG;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 2-bone IK: put the limb's tip on `target` (world space).
 * Returns the two joint angles, or null if the limb cannot do IK in this view.
 * Of the two possible bends, picks the one inside the joint limits that is
 * closest to the current pose, so the elbow never flips while dragging.
 */
export function solveLimbIK(
  rig: Rig, view: RigView, pose: Pose, unlocked: Set<JointId>, limb: LimbDef, target: Pt,
): { upper: number; lower: number } | null {
  const s = view.pivots[limb.upper], k = view.pivots[limb.lower], e = view.tips[limb.id];
  if (!s || !k || !e || !canBend(view, unlocked, limb.upper) || !canBend(view, unlocked, limb.lower)) return null;

  const mats = boneMatrices(view, pose, unlocked);
  const t = apply(invert(mats[JOINT_BY_ID[limb.upper].parent]), target);
  const l1 = dist(s, k), l2 = dist(k, e);
  if (l1 < 1e-6 || l2 < 1e-6) return null;

  const eps = 1e-6 * (l1 + l2);
  const d = Math.min(l1 + l2 - eps, Math.max(Math.abs(l1 - l2) + eps, dist(s, t)));
  const phi = dist(s, t) < 1e-9 ? ang(s, k) : ang(s, t);
  const tc = { x: s.x + d * Math.cos(phi * DEG), y: s.y + d * Math.sin(phi * DEG) };
  const alpha = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))) / DEG;

  const restUpper = ang(s, k), restLower = ang(k, e);
  const curU = pose.angles[limb.upper] ?? 0, curL = pose.angles[limb.lower] ?? 0;
  const limU = rig.limits[limb.upper], limL = rig.limits[limb.lower];

  let best: { upper: number; lower: number; cost: number } | null = null;
  for (const sign of [1, -1]) {
    const dirU = phi + sign * alpha;
    const elbow = { x: s.x + l1 * Math.cos(dirU * DEG), y: s.y + l1 * Math.sin(dirU * DEG) };
    const upper = normDeg(dirU - restUpper);
    const lower = normDeg(ang(elbow, tc) - restLower - upper);
    const cu = clampToLimit(upper, limU), cl = clampToLimit(lower, limL);
    const outside = Math.abs(cu - upper) + Math.abs(cl - lower);
    const cost = outside * 1000 + Math.abs(normDeg(upper - curU)) + Math.abs(normDeg(lower - curL));
    if (!best || cost < best.cost) best = { upper: cu, lower: cl, cost };
  }
  return best && { upper: best.upper, lower: best.lower };
}

/**
 * FK drag: how far the cursor swung around a joint's pivot, measured in the
 * parent bone's space so flips and parent rotations need no special cases.
 */
export function swingAround(parentWorld: Mat, pivot: Pt, fromWorld: Pt, toWorld: Pt): number {
  const inv = invert(parentWorld);
  return normDeg(ang(pivot, apply(inv, toWorld)) - ang(pivot, apply(inv, fromWorld)));
}

// ---------------------------------------------------------------------------
// Swaps: which drawing fills each slot in a pose.

export interface DrawItem {
  /** Key of the piece's images in the view. */
  piece: string;
  bone: BoneId;
  /** Extra placement before the bone matrix (shared hands). */
  xf?: Mat;
  pass: 'line' | 'fill' | 'whole';
}

/** Where a shared hand lands: wrist on the limb's tip, pointing along the forearm, mirrored for the right side. */
function sharedHandXf(view: RigView, side: 'L' | 'R', anchor: Pt): Mat | null {
  const tip = view.pivots[`wrist_${side}`] ?? view.tips[`arm_${side}`];
  const from = view.pivots[`wrist_${side}`] ? view.pivots[`elbow_${side}`] ?? view.pivots[`shoulder_${side}`] : view.pivots[`elbow_${side}`] ?? view.pivots[`shoulder_${side}`];
  if (!tip || !from) return null;
  return mul(translate(tip.x, tip.y), mul(rotate(ang(from, tip) - 90), mul(scale(side === 'R' ? -1 : 1, 1), translate(-anchor.x, -anchor.y))));
}

/** Variant names on offer per slot in a view. Replacement slots also accept '' (the piece as drawn). */
export function swapOptions(view: RigView): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (slot: string, v: string) => { (out[slot] ??= []).includes(v) || out[slot].push(v); };
  for (const p of Object.values(view.pieces)) {
    if (!p.variant || !p.slot) continue;
    if (p.shared === 'hand') { add('hand_L', p.variant); add('hand_R', p.variant); } else add(p.slot, p.variant);
  }
  return out;
}

const DEFAULT_VARIANTS = ['rest', 'open', 'default', 'normal', 'front'];
/** The variant an overlay slot shows when the pose does not say. */
export function defaultVariant(options: string[]): string {
  return DEFAULT_VARIANTS.find((v) => options.includes(v)) ?? options[0];
}

/** Everything to draw for a pose, back to front, with swaps resolved and the two-pass order applied. */
export function drawList(view: RigView, pose: Pose): DrawItem[] {
  const out: DrawItem[] = [];
  const swaps = pose.swaps ?? {};
  const options = swapOptions(view);
  const entries = Object.entries(view.pieces);
  for (const group of pose.groupOrder ?? view.groupOrder) {
    const members: { piece: string; bone: BoneId; xf?: Mat; z: number }[] = [];
    const slots = new Set(entries.filter(([, p]) => p.group === group && !p.variant).map(([n]) => n));
    // A shared hand can fill a hand slot even when the character has no hand piece of its own.
    for (const side of ['L', 'R'] as const) if (group === `arm_${side}` && swaps[`hand_${side}`]) slots.add(`hand_${side}`);
    for (const slot of slots) {
      const base = view.pieces[slot];
      const want = swaps[slot];
      const own = want ? view.pieces[`${slot}_${want}`] : undefined;
      const side = /^hand_([LR])$/.exec(slot)?.[1] as 'L' | 'R' | undefined;
      const shared = want && !own && side ? view.pieces[`hand_${want}`] : undefined;
      if (own) members.push({ piece: `${slot}_${want}`, bone: own.bone, z: base?.z ?? own.z });
      else if (shared?.anchor) {
        const xf = sharedHandXf(view, side!, shared.anchor);
        if (xf) members.push({ piece: `hand_${want}`, bone: `hand_${side}`, xf, z: base?.z ?? 1e6 });
      } else if (base) members.push({ piece: slot, bone: base.bone, z: base.z });
    }
    members.sort((a, b) => a.z - b.z);
    for (const pass of ['line', 'fill'] as const) for (const m of members) out.push({ piece: m.piece, bone: m.bone, xf: m.xf, pass });
    for (const slot of OVERLAY_SLOTS) {
      if (!options[slot] || pieceGroupOf(view, slot) !== group) continue;
      const v = swaps[slot] && options[slot].includes(swaps[slot]) ? swaps[slot] : defaultVariant(options[slot]);
      if (swaps[slot] === 'none') continue;
      const name = `${slot}_${v}`;
      if (view.pieces[name]) out.push({ piece: name, bone: view.pieces[name].bone, pass: 'whole' });
    }
  }
  return out;
}
function pieceGroupOf(view: RigView, slot: string): string | undefined {
  return Object.values(view.pieces).find((p) => p.slot === slot && p.overlay)?.group;
}
