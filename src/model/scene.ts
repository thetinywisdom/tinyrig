// A scene: one storyboard panel, animated. It sits on an endless canvas and holds
//   - its cast (characters from the shared cast, each with its own lane of poses),
//   - image layers (anything: a sky, a rooftop, leaves in front, a title),
//   - one stack order for all of them, front to back,
//   - a camera: a frame with the project's shape, keyed over time, that moves or cuts between keys,
//   - rig tweaks: a character's rig changed for this scene only.
// The exported picture is what the camera frame sees. Pure data and maths: no DOM.
import type { Landmark } from '../capture/mapping';
import { type ActedPose, type CastMember, type Moment } from './act';
import { placeActor } from './actor';
import { FPS, newShot, setKey, uid, type Actor, type Background, type FormatDef, type Shot } from './shot';
import type { Pose, Pt, Rig } from './types';

// ---------------------------------------------------------------------------------------------
// Project size: one shape for every scene in the project.

export type SizeId = 'reels' | 'fhd' | 'square' | 'post45' | 'custom';
export interface ProjectSize { id: SizeId; w: number; h: number }
export const SIZES: { id: SizeId; label: string; w: number; h: number }[] = [
  { id: 'reels', label: 'Reels · TikTok · Shorts', w: 1080, h: 1920 },
  { id: 'fhd', label: 'Full HD', w: 1920, h: 1080 },
  { id: 'square', label: 'Square', w: 1080, h: 1080 },
  { id: 'post45', label: '4:5 post', w: 1080, h: 1350 },
];
export const DEFAULT_SIZE: ProjectSize = { id: 'fhd', w: 1920, h: 1080 };
export const sizeLabel = (s: ProjectSize) => SIZES.find((x) => x.id === s.id)?.label ?? 'Custom';
/** The renderer's name for an output shape. */
export const sizeFormat = (s: ProjectSize): FormatDef => ({ id: `size-${s.w}x${s.h}`, label: sizeLabel(s), ratio: `${s.w}:${s.h}`, w: s.w, h: s.h, vertical: s.h > s.w });

// ---------------------------------------------------------------------------------------------
// What a scene holds

/** One pose in a character's lane. */
export interface LanePose {
  id: string;
  /** Seconds this pose holds still. */
  hold: number;
  /** Seconds to move from this pose to the next. */
  move: number;
  pose: ActedPose;
  /** The photo it was acted from (photos/ folder), its size, and the body points found in it. */
  photo?: string;
  size?: { w: number; h: number };
  points?: Landmark[];
  mirror?: boolean;
}
/** A character's poses in order, starting `start` seconds into the scene. */
export interface Lane { start: number; poses: LanePose[] }

/** An image on the canvas, shown from `start` to `end` seconds (missing: the whole scene). */
export interface ImageLayer { id: string; file: string; x: number; y: number; scale: number; start?: number; end?: number }

export type CameraCurve = 'smooth' | 'linear' | 'snap';
/** Where the camera frame is at a moment: its centre and its width on the canvas (the height follows the size). */
export interface CameraKey {
  id: string;
  /** Seconds into the scene. */
  t: number;
  x: number; y: number; width: number;
  /** How the camera gets here from the key before: it moves, or it cuts. */
  arrive: 'move' | 'cut';
  /** The shape of the move into this key. */
  curve: CameraCurve;
}

/** A scene's stack, front to back: cast members by cast id, image layers by layer id. */
export type StackEntry = { kind: 'cast'; id: string } | { kind: 'image'; id: string };

export interface SceneData {
  cast?: CastMember[];
  lanes?: Record<string, Lane>;
  images?: ImageLayer[];
  /** Front to back. Anything missing goes to the front (cast) or the back (images). */
  stack?: StackEntry[];
  camera?: CameraKey[];
  /** Rigs changed for this scene only, by character name. Missing: the shared rig. */
  rigs?: Record<string, Rig>;
}

export const DEFAULT_HOLD = 0.5;
export const DEFAULT_MOVE = 0.5;
const sec = (s: number) => Math.round(s * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Older panels: one shared list of moments with every character's pose, and one background.

interface OldPanel extends SceneData { moments?: Moment[]; background?: { file: string; x: number; y: number; scale: number } }

/** Move an older acted panel onto lanes and layers. Safe to call on any panel, any number of times. */
export function upgradeScene(p: OldPanel) {
  if (p.moments?.length && p.cast?.length && !p.lanes) {
    p.lanes = {};
    for (const c of p.cast) {
      let last: ActedPose | null = null;
      const poses: LanePose[] = [];
      for (const m of p.moments) {
        const pose: ActedPose | null = m.poses[c.id] ?? last;
        if (!pose) continue;
        last = pose;
        const own = !m.actor || m.actor === c.id;
        poses.push({
          id: `${m.id}-${c.id}`, hold: m.hold, move: m.move, pose,
          ...(own && m.photo ? { photo: m.photo, size: m.size, points: m.points, mirror: m.mirror } : {}),
        });
      }
      p.lanes[c.id] = { start: 0, poses };
    }
  }
  if (p.background && !p.images) {
    p.images = [{ id: 'background', file: p.background.file, x: p.background.x, y: p.background.y, scale: p.background.scale }];
  }
  delete p.moments;
  delete p.background;
}

// ---------------------------------------------------------------------------------------------
// Time

/** When each pose of a lane starts and stops holding, in seconds from the scene's start. */
export function laneTimes(lane: Lane): { start: number; holdEnd: number; end: number }[] {
  let t = lane.start;
  return lane.poses.map((p, i) => {
    const start = t, holdEnd = start + p.hold;
    t = holdEnd + (i < lane.poses.length - 1 ? p.move : 0);
    return { start: sec(start), holdEnd: sec(holdEnd), end: sec(t) };
  });
}
export const laneEnd = (lane: Lane) => laneTimes(lane).at(-1)?.holdEnd ?? lane.start;

/** The scene's length in seconds: the last pose, camera key or layer end. 0 when nothing is animated. */
export function sceneSeconds(s: SceneData): number {
  let end = 0;
  for (const lane of Object.values(s.lanes ?? {})) end = Math.max(end, laneEnd(lane));
  for (const k of s.camera ?? []) end = Math.max(end, k.t);
  for (const l of s.images ?? []) if (l.end !== undefined) end = Math.max(end, l.end);
  return sec(end);
}

/** Whether a scene has anything animated (it then shows what its camera sees, not its sketch). */
export const isAnimated = (s: SceneData) => Object.values(s.lanes ?? {}).some((l) => l.poses.length > 0) || !!s.images?.length;

/** The front-to-back stack with every cast member and image in it once. */
export function stackOf(s: SceneData): StackEntry[] {
  const cast = s.cast ?? [], images = s.images ?? [];
  const known = (e: StackEntry) => (e.kind === 'cast' ? cast.some((c) => c.id === e.id) : images.some((l) => l.id === e.id));
  const out = (s.stack ?? []).filter(known);
  const has = (e: StackEntry) => out.some((x) => x.kind === e.kind && x.id === e.id);
  for (const c of cast) { const e: StackEntry = { kind: 'cast', id: c.id }; if (!has(e)) out.unshift(e); }
  for (const l of images) { const e: StackEntry = { kind: 'image', id: l.id }; if (!has(e)) out.push(e); }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Camera

const curves: Record<CameraCurve, (u: number) => number> = {
  linear: (u) => u,
  smooth: (u) => u * u * (3 - 2 * u),
  snap: (u) => 1 - Math.pow(1 - u, 3),
};

/** The frame height for a width, in the project's shape. */
export const frameHeight = (width: number, size: ProjectSize) => (width * size.h) / size.w;

/** A framing that shows the whole stage area the old panels used (2880 × 1920), in the project's shape. */
export function defaultFraming(size: ProjectSize): Pick<CameraKey, 'x' | 'y' | 'width'> {
  const stage = { w: 2880, h: 1920 };
  // As large as fits inside the 1920 × 1080 middle band, like the shot editor's framing.
  const width = Math.min(1920, (1080 * size.w) / size.h);
  return { x: stage.w / 2, y: stage.h / 2, width };
}

/** Where the camera is at a time (seconds). Before the first key it waits on the first; after the last, on the last. */
export function cameraAt(s: SceneData, size: ProjectSize, t: number): { x: number; y: number; width: number } {
  const keys = [...(s.camera ?? [])].sort((a, b) => a.t - b.t);
  if (!keys.length) return defaultFraming(size);
  if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y, width: keys[0].width };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t >= b.t) continue;
    if (b.arrive === 'cut') return { x: a.x, y: a.y, width: a.width };
    const u = curves[b.curve]((t - a.t) / Math.max(1e-6, b.t - a.t));
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, width: a.width + (b.width - a.width) * u };
  }
  const last = keys.at(-1)!;
  return { x: last.x, y: last.y, width: last.width };
}

/** Change the project's shape: every key keeps its centre and how much of the canvas it covers. */
export function resizeCamera(s: SceneData, from: ProjectSize, to: ProjectSize) {
  for (const k of s.camera ?? []) {
    const area = k.width * frameHeight(k.width, from);
    k.width = Math.sqrt((area * to.w) / to.h);
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing: a scene as a Shot the renderer already knows how to draw and export.

const toPose = (p: ActedPose, c: CastMember): Pose => ({
  view: p.view, flip: p.flip, rootAngle: p.rootAngle, angles: { ...p.angles }, swaps: p.swaps ? { ...p.swaps } : undefined,
  root: { ...c.root }, scale: c.scale,
});
const frames = (s: number) => Math.max(0, Math.round(s * FPS));

/**
 * The scene as a shot: one actor per cast member, keyed at the start and end of every hold; image layers; the
 * stack order; and the camera where it is at `t` (seconds) under the size's format id.
 * `minSeconds` keeps a still scene from being one frame long.
 */
export function compileScene(name: string, s: SceneData, size: ProjectSize, opts: { t?: number; minSeconds?: number } = {}): Shot & { rigs?: Record<string, Rig> } {
  const shot = newShot(name);
  shot.stage = { w: 0, h: 0, color: '#ffffff' }; // endless: no paper
  shot.length = Math.max(1, frames(Math.max(sceneSeconds(s), opts.minSeconds ?? 0)));
  shot.actors = (s.cast ?? []).map((c): Actor => {
    const lane = s.lanes?.[c.id];
    const poses = lane?.poses ?? [];
    const actor: Actor = {
      id: c.id, character: c.character, role: 'actor', keys: [], mouth: [],
      base: toPose(poses[0]?.pose ?? { view: 'front', flip: false, rootAngle: 0, angles: {} }, c),
    };
    if (lane) {
      laneTimes(lane).forEach((t, i) => {
        const pose = toPose(poses[i].pose, c);
        setKey(actor, frames(t.start), pose, 'ease');
        if (t.holdEnd > t.start) setKey(actor, frames(t.holdEnd), pose, 'ease');
      });
    }
    return actor;
  });
  shot.backgrounds = (s.images ?? []).map((l): Background => ({
    id: l.id, file: l.file, x: l.x, y: l.y, scale: l.scale, locked: true,
    start: l.start !== undefined ? frames(l.start) : undefined, end: l.end !== undefined ? frames(l.end) : undefined,
  }));
  // The renderer stacks back to front.
  shot.order = stackOf(s).map((e) => e.id).reverse();
  const f = sizeFormat(size);
  const cam = cameraAt(s, size, opts.t ?? 0);
  shot.cameras = { [f.id]: { x: cam.x, y: cam.y, width: cam.width, custom: true } };
  return Object.assign(shot, s.rigs && Object.keys(s.rigs).length ? { rigs: s.rigs } : {});
}

/** Put a character into a scene, standing in the middle of what the camera sees at `t`. Returns its cast id. */
export function addCast(s: SceneData, character: string, rig: Rig, size: ProjectSize, t = 0): string | null {
  const placed = placeActor(newShot('cast'), character, rig);
  if (!placed) return null;
  s.cast ??= [];
  s.lanes ??= {};
  const cam = cameraAt(s, size, t);
  const n = s.cast.length, dx = [0, -1, 1][n % 3] * cam.width * 0.22;
  // placeActor stands it in the middle of a 2880 × 1920 stage; move that middle to the camera's.
  const shift = { x: cam.x + dx - 1440, y: cam.y - 960 };
  const id = uid();
  s.cast.push({ id, character, root: { x: placed.base.root.x + shift.x, y: placed.base.root.y + shift.y }, scale: placed.base.scale ?? 1 });
  s.lanes[id] = { start: 0, poses: [] };
  return id;
}

/** A new pose lane entry. */
export const newLanePose = (id: string, pose: ActedPose, extra: Partial<LanePose> = {}): LanePose =>
  ({ id, hold: DEFAULT_HOLD, move: DEFAULT_MOVE, pose, ...extra });

export type { Pt };
