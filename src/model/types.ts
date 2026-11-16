import type { BoneId, JointId, LimbId, RigLevel, ViewId } from './skeleton';

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/** One drawn piece in one view, as stored in rig.json. */
export interface RigPiece {
  bone: BoneId;
  group: string;
  /** Where the piece's images sit, in the view's own stage units. */
  bbox: Rect;
  /** Image pixels per stage unit. */
  scale: number;
  /** Default stacking inside its group (higher = in front). */
  z: number;
  /** Set on swap variants: what it replaces or which layer it belongs to, and its name there. */
  slot?: string;
  variant?: string;
  overlay?: boolean;
  shared?: 'hand';
  /** Shared hands only: the wrist point in the art, which lands on the character's wrist. */
  anchor?: Pt;
}

export interface RigView {
  pieces: Record<string, RigPiece>;
  /** Joint pivots in rest-pose stage units. A joint with no pivot cannot bend. */
  pivots: Record<JointId, Pt>;
  /** The point the whole character moves and turns around. */
  rootPivot: Pt;
  /** Where each limb ends (wrist / ankle, or the tip of the last piece): the IK handle. */
  tips: Partial<Record<LimbId, Pt>>;
  /** Default draw order of outline groups, back to front. */
  groupOrder: string[];
  /** Side and 3/4 drawings: which way the character looks, as you see it. Missing means left. */
  faces?: 'left' | 'right';
}

/** A point where a part turns, with a name you choose. The part's layers move with it. */
export interface RigNode {
  /** Key of its point in each view's pivots, and of its angle in a pose. */
  id: JointId;
  /** The part that turns here: layers attach to it. */
  bone: BoneId;
  name: string;
  /** The part it moves with. Null for the root, whose point is the view's rootPivot. */
  parent: BoneId | null;
}

/** characters/<name>/rig.json */
export interface Rig {
  version: 1;
  name: string;
  source: 'svg' | 'psd';
  level: RigLevel;
  /** How the source was imported, so the project can re-read it: one file, or one file per piece. */
  importMode?: 'whole' | 'parts';
  views: Partial<Record<ViewId, RigView>>;
  /** The character's own rig. Missing means the human rig every older character has. */
  nodes?: RigNode[];
  /** Which starting rig the nodes began from. */
  kind?: 'human' | 'two' | 'four';
  /** Joint limits in degrees from the rest pose, [min, max]. Missing = free. */
  limits: Record<JointId, [number, number]>;
}

/** poses/<name>.json — angles, not positions, so a pose fits any character. */
export interface Pose {
  view: ViewId;
  flip: boolean;
  root: Pt;
  rootAngle: number;
  /** Degrees from the rest pose, per joint. */
  angles: Record<JointId, number>;
  /** Draw-order override for this pose only. */
  groupOrder?: string[];
  /** Knob position of each controller pad, by pad id. */
  pads?: Record<string, Pt>;
  /** Swap choices: slot (mouth, eyes, hair, or a piece name) to variant name. Missing = default. */
  swaps?: Record<string, string>;
  /** Size in the scene. Missing = 1. */
  scale?: number;
}

/** poses/<name>.json — a pose in the library. No position, so it can be applied anywhere. */
export interface SavedPose {
  name: string;
  tags: string[];
  view: ViewId;
  flip: boolean;
  rootAngle: number;
  angles: Record<JointId, number>;
  groupOrder?: string[];
  swaps?: Record<string, string>;
  /** Small PNG preview as a data URL (saved as poses/<name>.png). */
  thumb?: string;
}

// ---------------------------------------------------------------------------
// Import-time data (not saved; rebuilt from the source file)

/** A coarse inside/outside grid of a piece, for hit tests and pivot guessing. */
export interface Mask {
  x: number; y: number; // stage position of the grid's top-left
  step: number; // stage units per cell
  w: number; h: number;
  inside: Uint8Array;
  /** Distance from each inside cell to the piece's edge, in stage units. */
  dist: Float32Array;
}

export interface PieceRaster {
  name: string;
  view: ViewId;
  bbox: Rect;
  scale: number;
  z: number;
  /** Outline pass: the piece's visible strokes. */
  line: HTMLCanvasElement;
  /** Fill pass: fills, cut away where the piece's own strokes show. */
  fill: HTMLCanvasElement;
  /** Fills before cutting (kept for PSD export of the placeholder). */
  fillRaw: HTMLCanvasElement;
  mask: Mask;
  hasStroke: boolean;
  hasFill: boolean;
  usesMask?: boolean;
}

export type Severity = 'error' | 'warn' | 'info';
export interface Issue { severity: Severity; text: string }

export interface ImportResult {
  name: string;
  source: 'svg' | 'psd';
  fileNames: string[];
  views: Partial<Record<ViewId, PieceRaster[]>>;
  /** Problems found while reading names and images (level-independent). */
  issues: Issue[];
  /** Other characters found in the same file. */
  otherCharacters: string[];
  /** Layers placed on a node by where they sit, not by their name: shown for checking. */
  guessed?: string[];
}
