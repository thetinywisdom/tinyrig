// The one skeleton every character shares, so poses transfer between characters.
// pelvis is the root -> chest -> head; chest -> upperarm -> forearm -> hand;
// pelvis -> thigh -> shin -> foot. 14 pivots.

export type Side = 'L' | 'R';
export const SIDES: Side[] = ['L', 'R'];

export type RigLevel = 'low' | 'medium' | 'high';
export const LEVELS: RigLevel[] = ['low', 'medium', 'high'];
export const LEVEL_RANK: Record<RigLevel, number> = { low: 0, medium: 1, high: 2 };

export type ViewId = 'front' | 'side' | 'back';
export const VIEWS: ViewId[] = ['front', 'side', 'back'];

export type BoneId = string; // 'pelvis' | 'chest' | 'head' | 'upperarm_L' ...
export type JointId = string; // 'waist' | 'neck' | 'shoulder_L' ...
export type LimbId = 'arm_L' | 'arm_R' | 'leg_L' | 'leg_R';

export interface JointDef {
  id: JointId;
  /** The bone this joint rotates. */
  bone: BoneId;
  parent: BoneId;
  /** Lowest rig level at which this joint bends. */
  minLevel: RigLevel;
  /** How the importer guesses the pivot: from the child's round end, or from both round ends. */
  guess: 'child' | 'both';
}

const J = (id: string, bone: string, parent: string, minLevel: RigLevel, guess: 'child' | 'both'): JointDef => ({
  id, bone, parent, minLevel, guess,
});

/** Parents always come before children. */
export const JOINTS: JointDef[] = [
  J('waist', 'chest', 'pelvis', 'high', 'both'),
  J('neck', 'head', 'chest', 'low', 'both'),
  ...SIDES.flatMap((s) => [
    J(`shoulder_${s}`, `upperarm_${s}`, 'chest', 'low', 'child'),
    J(`elbow_${s}`, `forearm_${s}`, `upperarm_${s}`, 'medium', 'both'),
    J(`wrist_${s}`, `hand_${s}`, `forearm_${s}`, 'high', 'both'),
    J(`hip_${s}`, `thigh_${s}`, 'pelvis', 'low', 'child'),
    J(`knee_${s}`, `shin_${s}`, `thigh_${s}`, 'medium', 'both'),
    J(`ankle_${s}`, `foot_${s}`, `shin_${s}`, 'high', 'both'),
  ]),
];

export const JOINT_BY_ID: Record<JointId, JointDef> = Object.fromEntries(JOINTS.map((j) => [j.id, j]));
export const JOINT_OF_BONE: Record<BoneId, JointDef> = Object.fromEntries(JOINTS.map((j) => [j.bone, j]));
export const ROOT_BONE: BoneId = 'pelvis';
export const BONES: BoneId[] = [ROOT_BONE, ...JOINTS.map((j) => j.bone)];

export interface LimbDef {
  id: LimbId;
  upper: JointId; // shoulder / hip
  lower: JointId; // elbow / knee
  end: JointId; // wrist / ankle
}

export const LIMBS: LimbDef[] = SIDES.flatMap((s) => [
  { id: `arm_${s}` as LimbId, upper: `shoulder_${s}`, lower: `elbow_${s}`, end: `wrist_${s}` },
  { id: `leg_${s}` as LimbId, upper: `hip_${s}`, lower: `knee_${s}`, end: `ankle_${s}` },
]);

/** Joints that bend at a rig level. Lower levels lock the joints they skip. */
export function unlockedJoints(level: RigLevel): Set<JointId> {
  return new Set(JOINTS.filter((j) => LEVEL_RANK[j.minLevel] <= LEVEL_RANK[level]).map((j) => j.id));
}

// ---------------------------------------------------------------------------
// Piece names (the art input contract)

export interface PieceDef {
  bone: BoneId;
  /** Outline group: all its lines are drawn first, then all its fills. */
  group: string;
}

export const PIECES: Record<string, PieceDef> = {
  head: { bone: 'head', group: 'head' },
  hair_back: { bone: 'head', group: 'hair_back' },
  chest: { bone: 'chest', group: 'torso' },
  pelvis: { bone: 'pelvis', group: 'torso' },
  torso: { bone: 'pelvis', group: 'torso' },
};
for (const s of SIDES) {
  for (const n of ['arm', 'upperarm']) PIECES[`${n}_${s}`] = { bone: `upperarm_${s}`, group: `arm_${s}` };
  PIECES[`forearm_${s}`] = { bone: `forearm_${s}`, group: `arm_${s}` };
  PIECES[`hand_${s}`] = { bone: `hand_${s}`, group: `arm_${s}` };
  for (const n of ['leg', 'thigh']) PIECES[`${n}_${s}`] = { bone: `thigh_${s}`, group: `leg_${s}` };
  PIECES[`shin_${s}`] = { bone: `shin_${s}`, group: `leg_${s}` };
  PIECES[`foot_${s}`] = { bone: `foot_${s}`, group: `leg_${s}` };
}

/** Names that are a group at High/Medium (holding pieces) but a single piece at Low. */
export const GROUP_OR_PIECE = new Set(['arm_L', 'arm_R', 'leg_L', 'leg_R']);

/** Bones that must carry a piece at each level, with the piece name the level expects. */
export function requiredBones(level: RigLevel): { bone: BoneId; expect: string }[] {
  const out: { bone: BoneId; expect: string }[] = [{ bone: 'head', expect: 'head' }];
  if (level === 'high') out.push({ bone: 'chest', expect: 'chest' }, { bone: 'pelvis', expect: 'pelvis' });
  else out.push({ bone: 'pelvis', expect: 'torso' });
  for (const s of SIDES) {
    out.push({ bone: `upperarm_${s}`, expect: level === 'low' ? `arm_${s}` : `upperarm_${s}` });
    out.push({ bone: `thigh_${s}`, expect: level === 'low' ? `leg_${s}` : `thigh_${s}` });
    if (level !== 'low') {
      out.push({ bone: `forearm_${s}`, expect: `forearm_${s}` }, { bone: `shin_${s}`, expect: `shin_${s}` });
    }
    if (level === 'high') {
      out.push({ bone: `hand_${s}`, expect: `hand_${s}` }, { bone: `foot_${s}`, expect: `foot_${s}` });
    }
  }
  return out;
}

export function suggestLevel(names: Iterable<string>): RigLevel {
  const set = new Set(names);
  if (set.has('chest') || set.has('pelvis')) return 'high';
  for (const n of set) if (/^(upperarm|forearm|thigh|shin)_[LR]$/.test(n)) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Name clean-up. Apps mangle layer names on export:
//   Illustrator  head_1_ , head_00000123_ , _x5F_ escapes, data-name="head"
//   Figma        head_2
//   Procreate    forearm_L_line / forearm_L_fill

export function normalizeName(raw: string): string {
  let s = raw.trim().replace(/_x([0-9A-Fa-f]{2,4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/[\s-]+/g, '_');
  for (;;) {
    const t = s.replace(/_\d+_?$/, '');
    if (t === s || !t) break;
    s = t;
  }
  return s.toLowerCase().replace(/_(l|r)(?=$|_)/g, (_, c) => '_' + c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Swap variants. Drawn in place on the character and named after what they replace:
//   mouth_a, eyes_closed, hair_wet      extra layers on the head, one shown at a time
//   forearm_L_bent, head_angry          replaces that piece
//   hand_fist (no side)                 a shared hand, drawn pointing down with the wrist
//                                       at the top edge; placed on either wrist

export interface VariantDef extends PieceDef {
  slot: string;
  variant: string;
  /** Drawn whole, on top of its group, instead of joining the two-pass outline. */
  overlay?: boolean;
  shared?: 'hand';
}

export const OVERLAY_SLOTS = ['hair', 'eyes', 'mouth'];
/** The lip-sync set, in the order the mouth picker shows it. */
export const MOUTH_SHAPES = ['rest', 'mbp', 'a', 'e', 'o', 'u', 'fv', 'L'];

export function parseVariant(name: string): VariantDef | null {
  if (PIECES[name]) return null;
  let m = /^mouths?_(.+)$/.exec(name);
  if (m) return { slot: 'mouth', variant: m[1], bone: 'head', group: 'head', overlay: true };
  m = /^eyes?_(.+)$/.exec(name);
  if (m) return { slot: 'eyes', variant: m[1], bone: 'head', group: 'head', overlay: true };
  m = /^hair_(.+)$/.exec(name);
  if (m) return { slot: 'hair', variant: m[1], bone: 'head', group: 'head', overlay: true };
  const base = Object.keys(PIECES).sort((x, y) => y.length - x.length).find((n) => name.startsWith(n + '_'));
  if (base) return { ...PIECES[base], slot: base, variant: name.slice(base.length + 1) };
  m = /^hands?_(.+)$/.exec(name);
  if (m) return { slot: 'hand', variant: m[1], bone: 'hand_L', group: 'arm_L', shared: 'hand' };
  return null;
}

/** Bone and outline group of any drawable name: a piece or a variant. */
export function pieceDef(name: string): (PieceDef & Partial<VariantDef>) | null {
  return PIECES[name] ?? parseVariant(name);
}

export type NameKind =
  | { kind: 'piece'; name: string; variant: boolean }
  | { kind: 'char'; name: string }
  | { kind: 'view'; view: ViewId }
  | { kind: 'group'; name: string }
  | { kind: 'unknown'; name: string };

export function classifyName(raw: string): NameKind {
  const name = normalizeName(raw);
  if (PIECES[name]) return { kind: 'piece', name, variant: false };
  const char = /^char_(.+)$/.exec(name);
  if (char) return { kind: 'char', name: char[1] };
  if ((VIEWS as string[]).includes(name)) return { kind: 'view', view: name as ViewId };
  // Folders that only hold variants.
  if (/^(library|variants|swaps|hands|mouths|eyes|hair|feet)$/.test(name)) return { kind: 'group', name };
  if (parseVariant(name)) return { kind: 'piece', name, variant: true };
  return { kind: 'unknown', name };
}

/** Procreate layers: `<piece>_line` over `<piece>_fill`. */
export function splitPsdLayerName(raw: string): { base: string; pass: 'line' | 'fill' | null } {
  const m = /^(.*?)[_\s-](line|fill)$/i.exec(raw.trim());
  if (m) return { base: m[1], pass: m[2].toLowerCase() as 'line' | 'fill' };
  return { base: raw, pass: null };
}

// ---------------------------------------------------------------------------
// Part-by-part import: one file per piece, named after the piece.
//   head.svg · forearm_L.svg · side_head.svg · momo_side_forearm_L.svg

export interface PartFileName {
  /** A piece or variant name, or null when the file name is not recognised. */
  piece: string | null;
  view: ViewId | null;
  char: string | null;
}

export function parsePartFileName(fileName: string): PartFileName {
  const tokens = normalizeName(fileName.replace(/\.[^.]+$/, '')).split('_').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens.slice(i).join('_');
    if (!pieceDef(name)) continue;
    const rest = tokens.slice(0, i).filter((t) => t !== 'char');
    const view = (rest.find((t) => (VIEWS as string[]).includes(t)) as ViewId | undefined) ?? null;
    return { piece: name, view, char: rest.filter((t) => t !== view).join('_') || null };
  }
  return { piece: null, view: null, char: null };
}

/** Separate files carry no layer order, so pieces stack in this order (back to front). */
export function defaultPartOrder(view: ViewId): string[] {
  const arm = (s: Side) => [`forearm_${s}`, `hand_${s}`, `upperarm_${s}`, `arm_${s}`];
  const leg = (s: Side) => [`shin_${s}`, `foot_${s}`, `thigh_${s}`, `leg_${s}`];
  const body = ['pelvis', 'torso', 'chest', 'head'];
  return view === 'side'
    ? [...arm('R'), ...leg('R'), 'hair_back', ...leg('L'), ...body, ...arm('L')] // far limbs behind the body
    : ['hair_back', ...leg('R'), ...leg('L'), ...body, ...arm('R'), ...arm('L')];
}
