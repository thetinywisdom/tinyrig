// A character's own rig: named nodes connected into a tree. Each node is a point where a part turns,
// and the part (one or more image layers) moves with it.
//
// Three starting rigs: human, 2-legged creature, 4-legged creature. They reuse the human joint ids
// where a body part plays the same role (a front leg is an arm, a back leg is a leg), so acting a pose
// out from a photo moves creatures too. Nodes added by the user get their own ids.
//
// A layer and a node with the same name are attached automatically: "L hand", "hand_L" and
// "Left Hand" are the same name.
import { JOINTS, JOINT_BY_ID, LEVEL_RANK, ROOT_BONE, unlockedJoints, type BoneId, type JointDef, type JointId, type RigLevel } from './skeleton';
import type { Pt, Rig, RigNode, RigView } from './types';

export type RigKind = 'human' | 'two' | 'four';
export const RIG_KINDS: RigKind[] = ['human', 'two', 'four'];
export const RIG_KIND_LABEL: Record<RigKind, string> = { human: 'Human', two: '2 legs', four: '4 legs' };
/** How many nodes a starting rig has. Stored as the rig's level (low, medium, high). */
export const DETAIL_LABEL: Record<RigLevel, string> = { low: 'Simple', medium: 'Medium', high: 'Complex' };

/** The root node's id. Its point is the view's rootPivot. */
export const ROOT_NODE = 'root';

// ---------------------------------------------------------------------------
// Names

const SIDE_WORDS: Record<string, 'l' | 'r'> = { l: 'l', left: 'l', r: 'r', right: 'r' };

/** Words of a name with the side pulled out: "L upper arm" → { side: 'l', words: ['upper', 'arm'] }. */
function words(name: string): { side: string; words: string[] } {
  const parts = name.trim().replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_\-.]+/).filter(Boolean)
    .filter((w, i, all) => !(/^\d+$/.test(w) && i === all.length - 1)); // Illustrator / Figma copies: hand_L_2
  let side = '';
  const rest: string[] = [];
  for (const w of parts) if (SIDE_WORDS[w] && !side) side = SIDE_WORDS[w]; else rest.push(w);
  return { side, words: rest };
}

/** Keys two names share when they mean the same part. Word order and spaces do not matter. */
export function nameKeys(name: string): string[] {
  const { side, words: w } = words(name);
  if (!w.length) return [];
  return [...new Set([w.join(''), [...w].sort().join('')])].map((k) => `${side}:${k}`);
}

export function sameName(a: string, b: string): boolean {
  const kb = new Set(nameKeys(b));
  return nameKeys(a).some((k) => kb.has(k));
}

const PART_LABEL: Record<string, string> = {
  pelvis: 'Hips', torso: 'Body', chest: 'Chest', head: 'Head', hair_back: 'Back hair',
  upperarm: 'upper arm', forearm: 'forearm', hand: 'hand', arm: 'arm', thigh: 'thigh', shin: 'shin', foot: 'foot', leg: 'leg',
};

/** How a layer or node name reads on screen: hand_L → "L hand", upperarm_R → "R upper arm", tail → "Tail". */
export function displayName(raw: string): string {
  const { side, words: w } = words(raw);
  const joined = w.join('_');
  const body = PART_LABEL[joined] ?? w.map((x) => PART_LABEL[x] ?? x).join(' ');
  const text = side ? `${side.toUpperCase()} ${body}` : body;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Starting rigs. `at` places a node when no layer says where it goes: a fraction of the drawing's box.

interface TemplateNode extends RigNode { at: Pt; level: RigLevel }
const N = (id: string, bone: string, name: string, parent: string | null, x: number, y: number, level: RigLevel = 'low'): TemplateNode =>
  ({ id, bone, name, parent, at: { x, y }, level });

const HUMAN_AT: Record<string, Pt> = {
  waist: { x: 0.5, y: 0.45 }, neck: { x: 0.5, y: 0.2 },
  shoulder_L: { x: 0.68, y: 0.24 }, elbow_L: { x: 0.74, y: 0.38 }, wrist_L: { x: 0.78, y: 0.5 },
  hip_L: { x: 0.56, y: 0.55 }, knee_L: { x: 0.57, y: 0.74 }, ankle_L: { x: 0.57, y: 0.93 },
};
const humanAt = (id: string): Pt => {
  const left = HUMAN_AT[id.replace(/_R$/, '_L')] ?? { x: 0.5, y: 0.5 };
  return id.endsWith('_R') ? { x: 1 - left.x, y: left.y } : left;
};

const HUMAN: TemplateNode[] = [
  N(ROOT_NODE, ROOT_BONE, 'Hips', null, 0.5, 0.55),
  ...JOINTS.map((j) => ({ id: j.id, bone: j.bone, name: displayName(j.bone), parent: j.parent, at: humanAt(j.id), level: j.minLevel })),
];

/** A bird or a dinosaur, seen from the side: body, head, tail, two legs. */
const TWO: TemplateNode[] = [
  N(ROOT_NODE, ROOT_BONE, 'Body', null, 0.5, 0.45),
  N('neck', 'head', 'Head', ROOT_BONE, 0.3, 0.3),
  N('tail', 'tail', 'Tail', ROOT_BONE, 0.72, 0.45, 'medium'),
  ...(['L', 'R'] as const).flatMap((s) => [
    N(`hip_${s}`, `thigh_${s}`, `${s} leg`, ROOT_BONE, s === 'L' ? 0.48 : 0.54, 0.55),
    N(`knee_${s}`, `shin_${s}`, `${s} lower leg`, `thigh_${s}`, s === 'L' ? 0.46 : 0.52, 0.72, 'medium'),
    N(`ankle_${s}`, `foot_${s}`, `${s} foot`, `shin_${s}`, s === 'L' ? 0.45 : 0.51, 0.9, 'high'),
  ]),
];

/** A cat, a dog, a horse, seen from the side: front legs act as arms, back legs as legs. */
const FOUR: TemplateNode[] = [
  N(ROOT_NODE, ROOT_BONE, 'Hips', null, 0.7, 0.4),
  N('waist', 'chest', 'Chest', ROOT_BONE, 0.35, 0.4, 'high'),
  N('neck', 'head', 'Head', 'chest', 0.22, 0.28),
  N('tail', 'tail', 'Tail', ROOT_BONE, 0.85, 0.35, 'medium'),
  ...(['L', 'R'] as const).flatMap((s) => {
    const dx = s === 'L' ? 0 : 0.04;
    return [
      N(`shoulder_${s}`, `upperarm_${s}`, `${s} front leg`, 'chest', 0.3 + dx, 0.5),
      N(`elbow_${s}`, `forearm_${s}`, `${s} front knee`, `upperarm_${s}`, 0.3 + dx, 0.7, 'medium'),
      N(`wrist_${s}`, `hand_${s}`, `${s} front paw`, `forearm_${s}`, 0.3 + dx, 0.9, 'high'),
      N(`hip_${s}`, `thigh_${s}`, `${s} back leg`, ROOT_BONE, 0.72 + dx, 0.5),
      N(`knee_${s}`, `shin_${s}`, `${s} back knee`, `thigh_${s}`, 0.72 + dx, 0.7, 'medium'),
      N(`ankle_${s}`, `foot_${s}`, `${s} back paw`, `shin_${s}`, 0.72 + dx, 0.9, 'high'),
    ];
  }),
];

const TEMPLATES: Record<RigKind, TemplateNode[]> = { human: HUMAN, two: TWO, four: FOUR };

/** Where each node of a starting rig sits, as a fraction of the drawing's box. */
export function jointSpots(kind: RigKind): Record<string, Pt> {
  return Object.fromEntries(TEMPLATES[kind].map((n) => [n.id, { ...n.at }]));
}
/** Human parts by where their middles sit in a front drawing (the character's L is on the viewer's right). */
export const HUMAN_PART_SPOTS: Record<string, Pt> = {
  head: { x: 0.5, y: 0.09 }, chest: { x: 0.5, y: 0.31 }, pelvis: { x: 0.5, y: 0.49 },
  upperarm_L: { x: 0.74, y: 0.3 }, forearm_L: { x: 0.8, y: 0.43 }, hand_L: { x: 0.85, y: 0.56 },
  thigh_L: { x: 0.6, y: 0.64 }, shin_L: { x: 0.61, y: 0.8 }, foot_L: { x: 0.64, y: 0.95 },
  upperarm_R: { x: 0.26, y: 0.3 }, forearm_R: { x: 0.2, y: 0.43 }, hand_R: { x: 0.15, y: 0.56 },
  thigh_R: { x: 0.4, y: 0.64 }, shin_R: { x: 0.39, y: 0.8 }, foot_R: { x: 0.36, y: 0.95 },
};
/**
 * Where each part (by bone) of a starting rig sits: the middle of the stretch from its node to the next one, or a
 * little past its node for an end part (head, hand, paw, tail).
 */
export function partSpots(kind: RigKind): Record<string, Pt> {
  if (kind === 'human') return { ...HUMAN_PART_SPOTS };
  const nodes = TEMPLATES[kind], at = (bone: string | null) => nodes.find((n) => n.bone === bone)?.at;
  const out: Record<string, Pt> = {};
  for (const n of nodes) {
    const child = nodes.find((c) => c.parent === n.bone);
    const parent = at(n.parent);
    if (child) out[n.bone] = { x: (n.at.x + child.at.x) / 2, y: (n.at.y + child.at.y) / 2 };
    else if (parent) out[n.bone] = { x: n.at.x + (n.at.x - parent.x) * 0.45, y: n.at.y + (n.at.y - parent.y) * 0.45 };
    else out[n.bone] = { ...n.at };
  }
  // Seen from the side, a creature's left and right legs stand on top of each other: spread them apart so both
  // can be seen (the far one a little lower).
  for (const [bone, p] of Object.entries(out)) {
    if (/_L$/.test(bone)) out[bone] = { x: p.x - 0.07, y: p.y };
    if (/_R$/.test(bone)) out[bone] = { x: p.x + 0.07, y: p.y + 0.04 };
  }
  return out;
}
/** A starting rig's nodes, up to a level of detail (all of them by default). */
export function templateNodes(kind: RigKind, level: RigLevel = 'high'): RigNode[] {
  const kept = TEMPLATES[kind].filter((n) => LEVEL_RANK[n.level] <= LEVEL_RANK[level]);
  const up = keptAncestor(TEMPLATES[kind], new Set(kept.map((n) => n.bone)));
  return kept.map(({ at: _at, level: _l, ...n }) => ({ ...n, parent: n.parent && up(n.parent) }));
}

/** The nearest part at or above `bone` that is still in the rig (the root if none is). */
export function keptAncestor(nodes: RigNode[], kept: Set<BoneId>): (bone: BoneId) => BoneId {
  const parent = new Map(nodes.map((n) => [n.bone, n.parent]));
  const root = rootNode(nodes).bone;
  return (bone) => {
    let b: BoneId | null | undefined = bone;
    for (let i = 0; b && !kept.has(b) && i < 200; i++) b = parent.get(b);
    return b && kept.has(b) ? b : root;
  };
}

// ---------------------------------------------------------------------------
// The skeleton a rig moves with

export interface Skeleton {
  /** Parents before children. */
  joints: JointDef[];
  root: BoneId;
  jointOfBone: Record<BoneId, JointDef>;
}

const HUMAN_SKELETON: Skeleton = {
  joints: JOINTS, root: ROOT_BONE, jointOfBone: Object.fromEntries(JOINTS.map((j) => [j.bone, j])),
};
const cache = new WeakMap<RigNode[], { key: string; skel: Skeleton }>();

/** The nodes of a rig. A rig made before custom rigs is the human rig. */
export const nodesOf = (rig: Rig): RigNode[] => rig.nodes ?? templateNodes('human');
export const rootNode = (nodes: RigNode[]): RigNode => nodes.find((n) => n.parent === null) ?? nodes[0];

export function skeletonOf(rig: Pick<Rig, 'nodes'>): Skeleton {
  const nodes = rig.nodes;
  if (!nodes) return HUMAN_SKELETON;
  const key = JSON.stringify(nodes);
  const hit = cache.get(nodes);
  if (hit?.key === key) return hit.skel;
  const root = rootNode(nodes);
  const joints: JointDef[] = [];
  const placed = new Set([root.bone]);
  // Parents before children; anything cut off from the root (should not happen) is left out.
  for (let added = true; added;) {
    added = false;
    for (const n of nodes) {
      if (n === root || placed.has(n.bone) || n.parent === null || !placed.has(n.parent)) continue;
      joints.push({ id: n.id, bone: n.bone, parent: n.parent, minLevel: JOINT_BY_ID[n.id]?.minLevel ?? 'low', guess: JOINT_BY_ID[n.id]?.guess ?? 'both' });
      placed.add(n.bone);
      added = true;
    }
  }
  const skel = { joints, root: root.bone, jointOfBone: Object.fromEntries(joints.map((j) => [j.bone, j])) };
  cache.set(nodes, { key, skel });
  return skel;
}

/** Joints that bend. Rigs with their own nodes bend everywhere; older human rigs follow their level. */
export function unlockedOf(rig: Rig): Set<JointId> {
  return rig.nodes ? new Set(skeletonOf(rig).joints.map((j) => j.id)) : unlockedJoints(rig.level);
}

/** Bones below `bone` (itself included). */
export function bonesBelow(nodes: RigNode[], bone: BoneId): Set<BoneId> {
  const out = new Set([bone]);
  for (let grew = true; grew;) {
    grew = false;
    for (const n of nodes) if (n.parent && out.has(n.parent) && !out.has(n.bone)) { out.add(n.bone); grew = true; }
  }
  return out;
}

/** The node a layer name belongs to: same name as the node, or as the part it moves (hand_L). */
export function nodeForName(nodes: RigNode[], layer: string): RigNode | undefined {
  return nodes.find((n) => sameName(n.name, layer)) ?? nodes.find((n) => !n.bone.startsWith('n_') && sameName(n.bone, layer));
}

/** A fresh id for a node the user adds. */
export function newNodeId(nodes: RigNode[]): string {
  let i = nodes.length;
  while (nodes.some((n) => n.id === `n_${i}` || n.bone === `n_${i}`)) i++;
  return `n_${i}`;
}

/** The name a piece is matched by: a variant matches by the piece it replaces. */
const pieceMatchName = (name: string, p: RigView['pieces'][string]) => (p.variant && p.slot && !p.overlay ? p.slot : name);

/**
 * Attach layers to nodes by name, in every view. Layers whose name matches no node keep their node if it is
 * still in the rig, or move with the root. With `only`, just the layers named like that node move to it, so
 * a layer you attached by hand stays where you put it.
 */
export function attachByName(rig: Rig, only?: RigNode) {
  const nodes = nodesOf(rig), bones = new Set(nodes.map((n) => n.bone)), root = rootNode(nodes).bone;
  for (const view of Object.values(rig.views)) {
    if (!view) continue;
    for (const [name, p] of Object.entries(view.pieces)) {
      if (p.shared) continue; // shared hands land on a wrist by themselves
      const layer = pieceMatchName(name, p);
      const n = only ? (sameName(only.name, layer) ? only : undefined) : nodeForName(nodes, layer);
      if (n) p.bone = n.bone;
      else if (!bones.has(p.bone)) p.bone = root;
    }
  }
}

/** Box around a view's pieces. */
export function viewBox(view: RigView): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of Object.values(view.pieces)) {
    if (p.variant) continue;
    x0 = Math.min(x0, p.bbox.x); y0 = Math.min(y0, p.bbox.y);
    x1 = Math.max(x1, p.bbox.x + p.bbox.w); y1 = Math.max(y1, p.bbox.y + p.bbox.h);
  }
  return x0 === Infinity ? { x: 0, y: 0, w: 100, h: 100 } : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Where a starting-rig node goes when nothing better is known. */
export function templateSpot(kind: RigKind, id: string, view: RigView, faces: 'left' | 'right'): Pt | null {
  const t = TEMPLATES[kind].find((n) => n.id === id);
  if (!t) return null;
  const b = viewBox(view);
  // Creatures are laid out looking left; a drawing that looks right gets the layout mirrored.
  const x = kind !== 'human' && faces === 'right' ? 1 - t.at.x : t.at.x;
  return { x: Math.round(b.x + b.w * x), y: Math.round(b.y + b.h * t.at.y) };
}

/** Guess which starting rig fits a set of layer names best. */
export function guessKind(layerNames: string[], kinds: RigKind[] = RIG_KINDS): RigKind {
  return fitKind(layerNames, kinds).kind;
}
/** The starting rig whose node names match the most layers, and how many. */
export function fitKind(layerNames: string[], kinds: RigKind[] = RIG_KINDS): { kind: RigKind; score: number } {
  let best: RigKind = kinds[0], bestScore = -1;
  for (const kind of kinds) {
    const nodes = templateNodes(kind);
    const score = layerNames.filter((l) => nodes.some((n) => sameName(n.name, l))).length;
    if (score > bestScore) { best = kind; bestScore = score; }
  }
  return { kind: best, score: bestScore };
}
