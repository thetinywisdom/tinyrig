// A shot: a scene (stage, backgrounds, placed characters, one camera framing per
// output shape) plus a keyframe timeline per acting character, sound and text.
import { normDeg } from './pose';
import type { Pose, Pt } from './types';

export const FPS = 24;
export const MAX_ACTORS = 3;

export interface FormatDef { id: string; label: string; ratio: string; w: number; h: number; vertical?: boolean }
/** Every output shape. Nothing above 1920 x 1080. */
export const FORMATS: FormatDef[] = [
  { id: 'yt', label: 'YouTube', ratio: '16:9', w: 1920, h: 1080 },
  { id: 'yt43', label: 'YouTube 4:3', ratio: '4:3', w: 1440, h: 1080 },
  { id: 'shorts', label: 'YouTube Shorts', ratio: '9:16', w: 1080, h: 1920, vertical: true },
  { id: 'reels', label: 'Instagram Reels', ratio: '9:16', w: 1080, h: 1920, vertical: true },
  { id: 'post45', label: 'Instagram post 4:5', ratio: '4:5', w: 1080, h: 1350 },
  { id: 'post34', label: 'Instagram post 3:4', ratio: '3:4', w: 1080, h: 1440 },
];
export const formatById = (id: string) => FORMATS.find((f) => f.id === id) ?? FORMATS[0];

/** A framing: the centre of the frame on the stage, and how many stage units it is wide. */
export interface Camera { x: number; y: number; width: number; /** Set once you frame this shape yourself. Until then it follows the 16:9 framing. */ custom?: boolean }
/**
 * An image layer: a background, a foreground, an ornament. `front` puts it in front of the characters.
 * It shows from `start` up to (not including) `end`; a missing start or end means the start or end of the shot.
 * (The field on the shot is still called `backgrounds`, so older project files keep opening.)
 */
export interface Background { id: string; file: string; x: number; y: number; scale: number; front?: boolean; start?: number; end?: number; opacity?: number }
export const layerSpan = (layer: Background, shot: Shot): [number, number] => [layer.start ?? 0, layer.end ?? shot.length];
export const visibleLayers = (shot: Shot, frame: number) => shot.backgrounds.filter((l) => frame >= (l.start ?? 0) && frame < (l.end ?? Infinity));

export type Ease = 'hold' | 'linear' | 'ease';
export type Timing = 1 | 2 | 3;
export interface Keyframe { frame: number; pose: Pose; ease: Ease }
export interface MouthKey { frame: number; shape: string }

export interface Actor {
  id: string;
  character: string;
  /** Actors animate. Extras hold one pose and are drawn once to a cached image. */
  role: 'actor' | 'extra';
  /** The pose when there are no keyframes (always, for an extra). */
  base: Pose;
  keys: Keyframe[];
  /** Mouth shapes, keyed separately so lip sync never disturbs the body keys. */
  mouth: MouthKey[];
  /** Overrides the shot's timing for this character. */
  timing?: Timing;
}

export interface TextItem {
  id: string;
  kind: 'text' | 'subtitle';
  text: string;
  start: number; end: number; // frames, end exclusive
  /** On-screen text only: position on the stage and size in stage units. */
  x: number; y: number; size: number; color: string;
}

export interface AudioClip {
  id: string;
  kind: 'dialogue' | 'music';
  /** File in the project's audio folder. */
  file: string;
  start: number;
  gain: number;
  /** Dialogue only: who is speaking (drives that character's mouth). */
  actor?: string;
}

export interface Shot {
  name: string;
  length: number;
  /** 1 = a new drawing every frame, 2 = every second frame ("on twos"), 3 = every third. */
  timing: Timing;
  timingRanges: { from: number; to: number; timing: Timing }[];
  stage: { w: number; h: number; color: string };
  backgrounds: Background[];
  actors: Actor[];
  cameras: Record<string, Camera>;
  texts: TextItem[];
  audio: AudioClip[];
  /** Font family for text and subtitles. */
  font: string;
}

/** scenes/<name>.json: everything about a shot except its timeline, to start new shots from. */
export interface SceneTemplate {
  name: string;
  stage: Shot['stage'];
  backgrounds: Background[];
  actors: Pick<Actor, 'character' | 'role' | 'base'>[];
  cameras: Record<string, Camera>;
}

export const uid = () => Math.random().toString(36).slice(2, 8);

export function defaultCameras(stage: { w: number; h: number }): Record<string, Camera> {
  // Every shape starts centred and as large as fits inside a 1920-wide, 1080-tall middle band of the stage.
  return Object.fromEntries(FORMATS.map((f) => {
    const width = Math.min(1920, stage.w, (Math.min(1920, stage.h) * f.w) / f.h);
    return [f.id, { x: stage.w / 2, y: stage.h / 2, width }];
  }));
}

export function newShot(name: string): Shot {
  const stage = { w: 2880, h: 1920, color: '#ffffff' };
  return {
    name, length: 96, timing: 1, timingRanges: [], stage, backgrounds: [], actors: [],
    cameras: defaultCameras(stage), texts: [], audio: [], font: 'sans-serif',
  };
}

/** Shapes you have not framed yourself stay centred on the 16:9 frame, at the same height. */
export function syncCameras(shot: Shot) {
  const base = shot.cameras.yt;
  if (!base) return;
  const height = (base.width * 1080) / 1920;
  for (const f of FORMATS) {
    if (f.id === 'yt') continue;
    const cam = (shot.cameras[f.id] ??= { x: base.x, y: base.y, width: base.width });
    if (!cam.custom) Object.assign(cam, { x: base.x, y: base.y, width: (height * f.w) / f.h });
  }
}

/** The frame rectangle of a camera on the stage. */
export function cameraRect(cam: Camera, format: FormatDef) {
  const h = (cam.width * format.h) / format.w;
  return { x: cam.x - cam.width / 2, y: cam.y - h / 2, w: cam.width, h };
}

/**
 * Parts of the frame that platform buttons and captions tend to cover, as fractions.
 * Approximate: the apps change these without notice, so treat them as a guide.
 */
export function safeArea(format: FormatDef) {
  return format.vertical ? { left: 0.05, right: 0.15, top: 0.1, bottom: 0.22 } : { left: 0.05, right: 0.05, top: 0.05, bottom: 0.05 };
}

// ---------------------------------------------------------------------------
// Timeline

export function timingAt(shot: Shot, actor: Actor, frame: number): Timing {
  const range = shot.timingRanges.find((r) => frame >= r.from && frame <= r.to);
  return range?.timing ?? actor.timing ?? shot.timing;
}

export const sortedKeys = (actor: Actor) => [...actor.keys].sort((a, b) => a.frame - b.frame);
export const keyAt = (actor: Actor, frame: number) => actor.keys.find((k) => k.frame === frame);

const clonePose = (p: Pose): Pose => JSON.parse(JSON.stringify(p));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpAngle = (a: number, b: number, t: number) => a + normDeg(b - a) * t;

/** Mix two poses. Angles turn the short way round; views, flips and swaps step (they never blend). */
export function mixPoses(a: Pose, b: Pose, t: number): Pose {
  const out = clonePose(a);
  out.root = { x: lerp(a.root.x, b.root.x, t), y: lerp(a.root.y, b.root.y, t) };
  out.rootAngle = lerpAngle(a.rootAngle, b.rootAngle, t);
  out.scale = lerp(a.scale ?? 1, b.scale ?? 1, t);
  out.angles = {};
  for (const j of new Set([...Object.keys(a.angles), ...Object.keys(b.angles)])) {
    out.angles[j] = lerpAngle(a.angles[j] ?? 0, b.angles[j] ?? 0, t);
  }
  return out;
}

/** The pose of a character at a frame: keys blended, held on the shot's timing, mouth keys on top. */
export function evaluate(shot: Shot, actor: Actor, frame: number): Pose {
  let pose: Pose;
  const keys = actor.role === 'extra' ? [] : sortedKeys(actor);
  if (!keys.length) pose = clonePose(actor.base);
  else {
    const n = timingAt(shot, actor, frame);
    const f = Math.floor(frame / n) * n;
    let i = -1;
    while (i + 1 < keys.length && keys[i + 1].frame <= f) i++;
    const k0 = keys[Math.max(0, i)], k1 = keys[i + 1];
    if (i < 0 || !k1 || k0.ease === 'hold') pose = clonePose(k0.pose);
    else {
      let t = (f - k0.frame) / (k1.frame - k0.frame);
      if (k0.ease === 'ease') t = t * t * (3 - 2 * t);
      pose = mixPoses(k0.pose, k1.pose, t);
    }
  }
  const shape = lastMouth(actor, frame);
  if (shape !== undefined) pose.swaps = { ...pose.swaps, mouth: shape };
  return pose;
}

function lastMouth(actor: Actor, frame: number): string | undefined {
  let best: MouthKey | undefined;
  for (const m of actor.mouth) if (m.frame <= frame && (!best || m.frame > best.frame)) best = m;
  return best?.shape;
}

/** Store a pose at a frame, replacing a key already there. New keys copy their neighbour's easing. */
export function setKey(actor: Actor, frame: number, pose: Pose, ease?: Ease) {
  const existing = keyAt(actor, frame);
  if (existing) { existing.pose = clonePose(pose); if (ease) existing.ease = ease; return; }
  const before = sortedKeys(actor).filter((k) => k.frame < frame).pop();
  actor.keys.push({ frame, pose: clonePose(pose), ease: ease ?? before?.ease ?? 'ease' });
  actor.keys.sort((a, b) => a.frame - b.frame);
}

export function setMouthKey(actor: Actor, frame: number, shape: string) {
  actor.mouth = actor.mouth.filter((m) => m.frame !== frame);
  actor.mouth.push({ frame, shape });
  actor.mouth.sort((a, b) => a.frame - b.frame);
}

/** Mouth flaps from loudness, one value per frame (0..1). Quiet is closed; louder opens wider. */
export function flapsFromVolume(volume: ArrayLike<number>, start: number, shapes: string[], step: number): MouthKey[] {
  const pick = (...want: string[]) => want.find((w) => shapes.includes(w));
  const closed = pick('rest', 'mbp') ?? shapes[0];
  const small = pick('e', 'u', 'mbp') ?? closed;
  const mid = pick('a', 'o') ?? small;
  const wide = pick('o', 'a') ?? mid;
  let peak = 0;
  for (let i = 0; i < volume.length; i++) peak = Math.max(peak, volume[i]);
  if (peak <= 0) return [];
  const keys: MouthKey[] = [];
  let last = '';
  for (let f = 0; f < volume.length; f += step) {
    let v = 0;
    for (let i = f; i < Math.min(volume.length, f + step); i++) v = Math.max(v, volume[i]);
    v /= peak;
    const shape = v < 0.08 ? closed : v < 0.3 ? small : v < 0.65 ? mid : wide;
    if (shape !== last) { keys.push({ frame: start + f, shape }); last = shape; }
  }
  if (last !== closed) keys.push({ frame: start + volume.length, shape: closed });
  return keys;
}

// ---------------------------------------------------------------------------
// Subtitles

const stamp = (frame: number) => {
  const ms = Math.round((frame / FPS) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
};

/** Subtitles as an .srt file, for YouTube. */
export function toSrt(shot: Shot): string {
  return shot.texts.filter((t) => t.kind === 'subtitle' && t.text.trim()).sort((a, b) => a.start - b.start)
    .map((t, i) => `${i + 1}\n${stamp(t.start)} --> ${stamp(t.end)}\n${t.text.trim()}\n`).join('\n');
}

export const visibleTexts = (shot: Shot, frame: number) => shot.texts.filter((t) => frame >= t.start && frame < t.end);
export type { Pt };
