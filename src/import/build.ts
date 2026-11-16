// Turns imported pieces into a rig: pivots guessed from overlapping round ends,
// default draw order, and the check report.
import {
  JOINTS, JOINT_BY_ID, JOINT_OF_BONE, LIMBS, pieceDef, PIECES, requiredBones, suggestLevel, VIEWS,
  type BoneId, type RigLevel, type ViewId,
} from '../model/skeleton';
import type { ImportResult, Issue, PieceRaster, Pt, Rig, RigView } from '../model/types';
import { attachByName, fitKind, keptAncestor, nodesOf, rootNode, sameName, skeletonOf, templateNodes, templateSpot, type RigKind } from '../model/rig';
import { ROOT_BONE } from '../model/skeleton';
import { guessPivot, maskCentroid, maskFarthest } from './raster';

/** Preferred piece on a bone when several attach to it (hair_back also rides the head bone). */
function primaryPiece(pieces: PieceRaster[], bone: BoneId): PieceRaster | undefined {
  const onBone = pieces.filter((p) => PIECES[p.name]?.bone === bone && p.name !== 'hair_back');
  return onBone.find((p) => p.name === bone) ?? onBone[0];
}

/** The nearest bone at or above `bone` that has a piece (Low rigs hang the head off the torso piece). */
function pieceAtOrAbove(pieces: PieceRaster[], bone: BoneId): PieceRaster | undefined {
  for (let b: BoneId | undefined = bone; b; b = JOINT_OF_BONE[b]?.parent) {
    const p = primaryPiece(pieces, b);
    if (p) return p;
  }
  return undefined;
}

function buildView(pieces: PieceRaster[], viewId: ViewId, issues: Issue[]): RigView {
  const view: RigView = { pieces: {}, pivots: {}, rootPivot: { x: 0, y: 0 }, tips: {}, groupOrder: [] };
  for (const p of pieces) {
    // A layer with a name of your own is a part too; it moves with the hips until a node takes it.
    const def = pieceDef(p.name) ?? { bone: ROOT_BONE, group: p.name };
    view.pieces[p.name] = { ...def, bbox: p.bbox, scale: p.scale, z: p.z };
    if (def.shared === 'hand') {
      // Drawn pointing down with the wrist at the top edge: the wrist point sits just inside that edge.
      const m = p.mask;
      let top = -1, sx = 0, n = 0;
      for (let j = 0; j < m.h && n === 0; j++) for (let i = 0; i < m.w; i++) if (m.inside[j * m.w + i]) { top = j; sx += i; n++; }
      const cx = maskCentroid(m)?.x ?? m.x + (sx / Math.max(1, n)) * m.step;
      let bottom = top;
      for (let j = m.h - 1; j > top; j--) if (m.inside.subarray(j * m.w, (j + 1) * m.w).some(Boolean)) { bottom = j; break; }
      view.pieces[p.name].anchor = round({ x: cx, y: m.y + (top + (bottom - top) * 0.12) * m.step });
    }
  }

  const noOverlap: string[] = [];
  for (const joint of JOINTS) {
    const child = primaryPiece(pieces, joint.bone);
    const parent = pieceAtOrAbove(pieces, joint.parent);
    if (!child || !parent) continue;
    let pivot = guessPivot(child.mask, parent.mask, joint.guess);
    if (!pivot) {
      noOverlap.push(`${joint.id} (${child.name} and ${parent.name})`);
      // Best effort so the joint is still usable: the child's point nearest the parent.
      const towards = maskCentroid(parent.mask) ?? { x: parent.bbox.x, y: parent.bbox.y };
      const far = maskFarthest(child.mask, towards), centre = maskCentroid(child.mask);
      pivot = far && centre ? { x: 2 * centre.x - far.x, y: 2 * centre.y - far.y } : centre;
    }
    if (pivot) view.pivots[joint.id] = round(pivot);
  }
  if (noOverlap.length) {
    issues.push({
      severity: 'warn',
      text: `${viewId}: pieces do not overlap at ${noOverlap.join(', ')}. The pivot is a rough guess; drag it into place in Edit rig.`,
    });
  }

  // The character moves and turns around the middle of its hips.
  const hips = [view.pivots.hip_L, view.pivots.hip_R].filter(Boolean) as Pt[];
  const rootPiece = primaryPiece(pieces, 'pelvis') ?? pieces[0];
  view.rootPivot = round(
    hips.length === 2 ? { x: (hips[0].x + hips[1].x) / 2, y: (hips[0].y + hips[1].y) / 2 }
      : maskCentroid(rootPiece.mask) ?? { x: rootPiece.bbox.x, y: rootPiece.bbox.y },
  );

  for (const limb of LIMBS) {
    const end = view.pivots[limb.end];
    const lowerPivot = view.pivots[limb.lower];
    if (end) view.tips[limb.id] = { ...end };
    else if (lowerPivot) {
      const last = primaryPiece(pieces, JOINT_BY_ID[limb.lower].bone);
      const far = last && maskFarthest(last.mask, lowerPivot);
      if (far) view.tips[limb.id] = round({ x: lowerPivot.x + (far.x - lowerPivot.x) * 0.9, y: lowerPivot.y + (far.y - lowerPivot.y) * 0.9 });
    }
  }

  const top = new Map<string, number>();
  for (const p of pieces) {
    const piece = view.pieces[p.name];
    if (!piece.variant) top.set(piece.group, Math.max(top.get(piece.group) ?? -1, p.z));
  }
  view.groupOrder = [...top.entries()].sort((a, b) => a[1] - b[1]).map(([g]) => g);
  return view;
}

const round = (p: Pt): Pt => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });

export function pieceNames(imp: ImportResult): Set<string> {
  const names = new Set<string>();
  for (const v of VIEWS) for (const p of imp.views[v] ?? []) if (PIECES[p.name]) names.add(p.name);
  return names;
}

export function buildRig(imp: ImportResult): { rig: Rig; issues: Issue[] } {
  const issues: Issue[] = [];
  const rig: Rig = { version: 1, name: imp.name, source: imp.source, level: suggestLevel(pieceNames(imp)), views: {}, limits: {} };
  for (const v of VIEWS) {
    const pieces = imp.views[v];
    if (pieces?.length) rig.views[v] = buildView(pieces, v, issues);
  }
  // Mostly names of your own: a creature or something else. Start from the rig its layer names fit best.
  const names = [...new Set(VIEWS.flatMap((v) => (imp.views[v] ?? []).map((p) => p.name)))];
  const creature = fitKind(names, ['two', 'four']);
  const human = names.filter((n) => PIECES[n]).length;
  if (creature.score > human) applyKind(rig, imp, creature.kind, 'high');
  // Nothing named like a body part (numbered layers, or names of your own): start from the human rig, and you
  // attach each layer to its node in Rig.
  else if (!human) applyKind(rig, imp, 'human', 'high');
  return { rig, issues };
}

/** Pieces of one view, by bone, as the rig attaches them now. */
function piecesOnBone(rig: Rig, view: ViewId, imp: ImportResult, bone: BoneId): PieceRaster[] {
  const rv = rig.views[view], node = nodesOf(rig).find((n) => n.bone === bone);
  const named = (p: PieceRaster) => p.name === bone || (node ? sameName(node.name, p.name) : false);
  // The layer named like the part comes first: a simple arm also carries the forearm and hand.
  return (imp.views[view] ?? []).filter((p) => rv?.pieces[p.name]?.bone === bone && !rv.pieces[p.name].variant)
    .sort((a, b) => Number(named(b)) - Number(named(a)));
}

/**
 * Guess where a node turns in a view: where its layer overlaps the layer it moves with, as the importer
 * does for human joints. Without layers to go by, the starting rig's spot (or the middle of its parent).
 */
export function guessNodePoint(rig: Rig, imp: ImportResult | undefined, view: ViewId, nodeId: string): Pt | null {
  const rv = rig.views[view];
  if (!rv) return null;
  const nodes = nodesOf(rig), node = nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const skel = skeletonOf({ nodes });
  if (imp && node.parent) {
    const child = piecesOnBone(rig, view, imp, node.bone)[0];
    let parent: PieceRaster | undefined;
    for (let b: BoneId | undefined = node.parent; b && !parent; b = skel.jointOfBone[b]?.parent) parent = piecesOnBone(rig, view, imp, b)[0];
    if (child && parent) {
      const guess = guessPivot(child.mask, parent.mask, skel.jointOfBone[node.bone]?.guess ?? 'both');
      if (guess) return round(guess);
      const towards = maskCentroid(parent.mask), far = towards && maskFarthest(child.mask, towards), centre = maskCentroid(child.mask);
      if (far && centre) return round({ x: 2 * centre.x - far.x, y: 2 * centre.y - far.y });
    }
  }
  if (imp && !node.parent) {
    // The root turns around the middle of its own layer.
    const c = piecesOnBone(rig, view, imp, node.bone)[0];
    const centre = c && maskCentroid(c.mask);
    if (centre) return round(centre);
  }
  return (rig.kind && templateSpot(rig.kind, node.id, rv, rv.faces ?? 'left')) || null;
}

/**
 * Use a starting rig at a level of detail. Changing only the detail keeps your names, connections, points and
 * the nodes you added; parts whose node goes move with the node above. A different starting rig starts over.
 */
export function applyKind(rig: Rig, imp: ImportResult | undefined, kind: RigKind, level: RigLevel = 'high') {
  const same = (rig.nodes ? rig.kind ?? 'human' : 'human') === kind;
  const old = nodesOf(rig);
  const full = templateNodes(kind).map((t) => {
    const o = same ? old.find((n) => n.id === t.id) : undefined;
    return o ? { ...t, name: o.name, parent: o.parent } : t;
  });
  const mine = same ? old.filter((n) => !full.some((t) => t.id === n.id)) : [];
  // Attach by name against the whole rig first, so a hand layer finds the hand before the hand is dropped.
  rig.nodes = [...full, ...mine];
  attachByName(rig);
  const wanted = new Set([...templateNodes(kind, level).map((n) => n.id), ...mine.map((n) => n.id)]);
  const kept = new Set(rig.nodes.filter((n) => wanted.has(n.id)).map((n) => n.bone));
  const up = keptAncestor(rig.nodes, kept);
  rig.nodes = rig.nodes.filter((n) => wanted.has(n.id)).map((n) => ({ ...n, parent: n.parent && up(n.parent) }));
  rig.kind = kind;
  rig.level = level;
  for (const rv of Object.values(rig.views)) for (const p of Object.values(rv?.pieces ?? {})) if (!p.shared) p.bone = up(p.bone);
  const root = rootNode(rig.nodes);
  for (const v of VIEWS) {
    const rv = rig.views[v];
    if (!rv) continue;
    const before = same ? rv.pivots : {};
    rv.pivots = {};
    rv.tips = {};
    for (const n of rig.nodes) {
      if (n === root) continue;
      const at = before[n.id] ?? guessNodePoint(rig, imp, v, n.id);
      if (at) rv.pivots[n.id] = at;
    }
    if (!same) {
      // Human hips: the middle between the two hip points, as for imported people.
      const hips = [rv.pivots.hip_L, rv.pivots.hip_R].filter(Boolean) as Pt[];
      rv.rootPivot = kind === 'human' && hips.length === 2
        ? round({ x: (hips[0].x + hips[1].x) / 2, y: (hips[0].y + hips[1].y) / 2 })
        : guessNodePoint(rig, imp, v, root.id) ?? rv.rootPivot;
    }
    for (const limb of LIMBS) if (rv.pivots[limb.end]) rv.tips[limb.id] = { ...rv.pivots[limb.end] };
  }
}

/** Pieces a level needs that a view does not have. */
export function levelIssues(rig: Rig, level: RigLevel): Issue[] {
  const issues: Issue[] = [];
  for (const v of VIEWS) {
    const view = rig.views[v];
    if (!view) continue;
    const bones = new Set(Object.values(view.pieces).filter((p) => !p.variant).map((p) => p.bone));
    const missing = requiredBones(level).filter((r) => !bones.has(r.bone)).map((r) => r.expect);
    if (missing.length) {
      issues.push({
        severity: v === 'front' ? 'error' : 'warn',
        text: `${v}: missing for ${level[0].toUpperCase() + level.slice(1)}: ${missing.join(', ')}`,
      });
    }
  }
  return issues;
}
