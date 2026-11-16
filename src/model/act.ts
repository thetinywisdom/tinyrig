// A panel you act out: who is in it, and a few poses in order. Each pose may come from a photo of you
// (with the body points the app found, after any dragging). The app moves from pose to pose.
// No timeline: a pose holds for a moment, then moves to the next. No DOM here.
import type { Landmark } from '../capture/mapping';
import type { JointId, ViewId } from './skeleton';
import { FPS, newShot, setKey, type Actor, type Background, type Shot } from './shot';
import type { Pose, Pt } from './types';

/** A character placed in a panel. Where it stands and its size stay the same in every pose. */
export interface CastMember { id: string; character: string; root: Pt; scale: number }

/** One character's pose in one moment: angles, never positions, like a saved pose. */
export interface ActedPose { view: ViewId; flip: boolean; rootAngle: number; angles: Record<JointId, number>; swaps?: Record<string, string> }

export interface Moment {
  id: string;
  /** Seconds this pose holds still. */
  hold: number;
  /** Seconds to move from this pose to the next. */
  move: number;
  /** The photo it was acted from, in the project's photos/ folder. */
  photo?: string;
  /** Size of that photo in pixels, the space the points live in. */
  size?: { w: number; h: number };
  /** The body the app found in the photo, after any dots you dragged. */
  points?: Landmark[];
  /** Copy the photo like a mirror (as the webcam shows you) rather than as it looks. */
  mirror?: boolean;
  /** The character this photo drives, by cast id. */
  actor?: string;
  /** Each character's pose here, by cast id. A character missing from a moment keeps its last pose. */
  poses: Record<string, ActedPose>;
}

/** A panel's background: one image, covering the stage. */
export interface PanelBackground { file: string; x: number; y: number; scale: number }

export interface Acted { cast: CastMember[]; moments: Moment[]; background?: PanelBackground }

export const DEFAULT_HOLD = 0.5;
export const DEFAULT_MOVE = 0.5;
const frames = (s: number) => Math.max(0, Math.round(s * FPS));

/** Where each moment starts and stops holding, in frames. The last one holds to the end. */
export function momentFrames(moments: Moment[]): { start: number; holdEnd: number }[] {
  let t = 0;
  return moments.map((m, i) => {
    const start = t, holdEnd = start + frames(m.hold);
    t = holdEnd + (i < moments.length - 1 ? frames(m.move) : 0);
    return { start, holdEnd };
  });
}

/** A panel's length in frames: every hold and every move between poses. At least one frame. */
export function actedFrames(moments: Moment[]): number {
  const last = momentFrames(moments).at(-1);
  return Math.max(1, last ? last.holdEnd : 0);
}

/** The moment showing at a frame (the one holding, or the one being moved away from). */
export function momentAt(moments: Moment[], frame: number): number {
  const times = momentFrames(moments);
  let i = 0;
  while (i + 1 < times.length && times[i + 1].start <= frame) i++;
  return i;
}

const toPose = (p: ActedPose, c: CastMember): Pose => ({
  view: p.view, flip: p.flip, rootAngle: p.rootAngle, angles: { ...p.angles }, swaps: p.swaps ? { ...p.swaps } : undefined,
  root: { ...c.root }, scale: c.scale,
});

/**
 * A shot the renderer can draw and export: one actor per cast member, keyed at the start and end of every hold,
 * easing between poses. `name` keeps pictures of different panels apart.
 */
export function compileActed(name: string, acted: Acted): Shot {
  const shot = newShot(name);
  shot.length = actedFrames(acted.moments);
  const times = momentFrames(acted.moments);
  shot.actors = acted.cast.map((c): Actor => {
    const actor: Actor = { id: c.id, character: c.character, role: 'actor', base: toPose({ view: 'front', flip: false, rootAngle: 0, angles: {} }, c), keys: [], mouth: [] };
    let last: ActedPose | null = null;
    acted.moments.forEach((m, i) => {
      const p = m.poses[c.id] ?? last;
      if (!p) return;
      last = p;
      setKey(actor, times[i].start, toPose(p, c), 'ease');
      if (times[i].holdEnd > times[i].start) setKey(actor, times[i].holdEnd, toPose(p, c), 'ease');
    });
    // Before its first acted pose, a character stands in that pose.
    const first = acted.moments.map((m) => m.poses[c.id]).find(Boolean);
    if (first) actor.base = toPose(first, c);
    return actor;
  });
  if (acted.background) {
    const bg: Background = { id: 'background', file: acted.background.file, x: acted.background.x, y: acted.background.y, scale: acted.background.scale, locked: true };
    shot.backgrounds = [bg];
  }
  return shot;
}
