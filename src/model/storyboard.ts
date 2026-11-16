// The storyboard: the scene as a grid of panels, read like a comic page.
// A project holds one scene. Each panel has a sketch, free-text notes and a duration,
// and, once it is animated, the shot that brings it to life. No DOM here.
import { DEFAULT_SIZE, isAnimated, sceneSeconds, upgradeScene, type ProjectSize, type SceneData } from './scene';
import { FPS, type AudioClip, type Shot } from './shot';

/** A panel is a scene: a sketch and notes to plan it, then its cast, layers and camera once animated. */
export interface Panel extends SceneData {
  id: string;
  /** Image file in the project's sketches/ folder. */
  sketch?: string;
  /** Everything else about the panel: dialogue, action, camera, sound. */
  notes: string;
  /** Seconds. An animated scene's own length wins when it is longer. */
  duration: number;
  /** Name of the shot that animates this panel (older projects). */
  shot?: string;
  /** Part of the sample scene, removed by "Clear sample". */
  sample?: boolean;
}

/** Whether a panel has been animated (it then shows what its camera sees, not its sketch). */
export const isActed = (p: Panel) => isAnimated(p);

/** Sound lives on the scene, so a line or a piece of music plays straight across the cuts. */
export type Lane = 'voice' | 'sfx' | 'music';
export const LANES: Lane[] = ['voice', 'sfx', 'music'];
export const LANE_LABEL: Record<Lane, string> = { voice: 'Voice', sfx: 'Sound effect', music: 'Music' };
/**
 * A sound on the scene's timeline. It is pinned to the panel it starts in (`offset` frames into it), so
 * reordering, inserting or resizing panels keeps every line with its picture.
 */
export interface SceneClip {
  id: string;
  lane: Lane;
  /** File in the project's audio/ folder. */
  file: string;
  panel: string;
  offset: number;
  gain: number;
  /** Voice only: the character speaking, by name. Their mouth row sits under the Voice lane. */
  speaker?: string;
  /** A scratch take recorded on this panel. A new take replaces it. */
  take?: boolean;
}

export interface Storyboard {
  name: string;
  panels: Panel[];
  sound?: SceneClip[];
  /** Show the original sketch on panels that are already animated. */
  showSketches?: boolean;
  /** The shape every scene is exported in. Missing: Full HD. */
  size?: ProjectSize;
}

export const sizeOf = (sb: Storyboard): ProjectSize => sb.size ?? DEFAULT_SIZE;

/** Bring an older storyboard up to date: acted panels move onto lanes and layers. */
export function upgradeStoryboard(sb: Storyboard): Storyboard {
  for (const p of sb.panels) upgradeScene(p);
  return sb;
}

export const DEFAULT_DURATION = 3;
export const MIN_DURATION = 0.25;

export const newPanel = (id: string, fields: Partial<Panel> = {}): Panel => ({ id, notes: '', duration: DEFAULT_DURATION, ...fields });
export const newStoryboard = (name = 'Untitled scene'): Storyboard => ({ name, panels: [] });

const shotOf = (panel: Panel, shots: Shot[]) => (panel.shot ? shots.find((s) => s.name === panel.shot) : undefined);

/** Seconds, rounded to a tenth. A panel with a shot lasts as long as its shot. */
export function panelSeconds(panel: Panel, shots: Shot[]): number {
  if (isActed(panel)) return Math.round(Math.max(sceneSeconds(panel), 0.5) * 10) / 10;
  const shot = shotOf(panel, shots);
  return Math.round((shot ? shot.length / FPS : panel.duration) * 10) / 10;
}

/** Set a panel's length. Its shot, if it has one, follows (whole frames, at least one). */
export function setPanelSeconds(panel: Panel, seconds: number, shots: Shot[]) {
  const s = Math.max(MIN_DURATION, Math.round(seconds * 100) / 100);
  panel.duration = s;
  const shot = shotOf(panel, shots);
  if (shot) shot.length = Math.max(1, Math.round(s * FPS));
}

export const runtimeSeconds = (sb: Storyboard, shots: Shot[]) => sb.panels.reduce((sum, p) => sum + panelSeconds(p, shots), 0);

/** 107.6 → "1:48". Under a minute → "0:07". */
export function formatRuntime(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Header line: "1:48 · 27 panels". */
export function summary(sb: Storyboard, shots: Shot[]): string {
  const n = sb.panels.length;
  return `${formatRuntime(runtimeSeconds(sb, shots))} · ${n} ${n === 1 ? 'panel' : 'panels'}`;
}

/** Move the panel at `from` so it ends up at index `to` (in the list after removal). */
export function movePanel(sb: Storyboard, from: number, to: number) {
  if (from < 0 || from >= sb.panels.length) return;
  const [p] = sb.panels.splice(from, 1);
  sb.panels.splice(Math.max(0, Math.min(sb.panels.length, to)), 0, p);
}

/** Natural order for dropped sketch files: panel2.png before panel10.png. */
export const byFileName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Every shot belongs to a panel. Shots made outside the storyboard get a panel at the end. */
export function linkShots(sb: Storyboard, shots: Shot[], makeId: () => string) {
  const linked = new Set(sb.panels.map((p) => p.shot).filter(Boolean));
  for (const shot of shots) {
    if (!linked.has(shot.name)) sb.panels.push(newPanel(makeId(), { shot: shot.name, duration: shot.length / FPS }));
  }
  // A panel pointing at a shot that no longer exists goes back to being a sketch.
  const names = new Set(shots.map((s) => s.name));
  for (const p of sb.panels) if (p.shot && !names.has(p.shot)) delete p.shot;
}

/** A shot name for a new shot, not used by any other: "Shot 4", then "Shot 4 (2)". */
export function freeShotName(base: string, shots: Shot[]): string {
  const used = new Set(shots.map((s) => s.name));
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} (${i})`)) return `${base} (${i})`;
}

// ---------------------------------------------------------------------------
// Scene time: every panel back to back, in frames.

/** A panel's length in frames: its shot's length, or its typed duration. */
export function panelFrames(panel: Panel, shots: Shot[]): number {
  if (isActed(panel)) return Math.max(1, Math.round(Math.max(sceneSeconds(panel), 0.5) * FPS));
  const shot = shotOf(panel, shots);
  return shot ? shot.length : Math.max(1, Math.round(panel.duration * FPS));
}

/** Where each panel starts in the scene, in frames. */
export function panelStarts(sb: Storyboard, shots: Shot[]): Map<string, number> {
  const out = new Map<string, number>();
  let t = 0;
  for (const p of sb.panels) { out.set(p.id, t); t += panelFrames(p, shots); }
  return out;
}
export const sceneFrames = (sb: Storyboard, shots: Shot[]) => sb.panels.reduce((t, p) => t + panelFrames(p, shots), 0);

/** The panel playing at a scene frame, and where it starts. Past the end: the last panel. */
export function panelAt(sb: Storyboard, shots: Shot[], frame: number): { panel: Panel; start: number } | null {
  let t = 0;
  for (const p of sb.panels) {
    const n = panelFrames(p, shots);
    if (frame < t + n) return { panel: p, start: t };
    t += n;
  }
  const last = sb.panels[sb.panels.length - 1];
  return last ? { panel: last, start: t - panelFrames(last, shots) } : null;
}

/** A clip's start in scene frames, or null if its panel is gone. */
export function clipStart(sb: Storyboard, shots: Shot[], clip: SceneClip, starts = panelStarts(sb, shots)): number | null {
  const at = starts.get(clip.panel);
  return at === undefined ? null : at + clip.offset;
}

/** Move a clip to a scene frame. It is pinned again to the panel it now starts in. */
export function placeClip(sb: Storyboard, shots: Shot[], clip: SceneClip, frame: number) {
  const hit = panelAt(sb, shots, Math.max(0, frame));
  if (!hit) return;
  clip.panel = hit.panel.id;
  clip.offset = Math.max(0, frame) - hit.start;
}

const KIND: Record<Lane, AudioClip['kind']> = { voice: 'dialogue', sfx: 'sfx', music: 'music' };

/**
 * The scene's clips as seen from one panel's shot: starts in that shot's frames, so a line that began in
 * the panel before has a negative start and plays on from the right place.
 */
export function shotClips(sb: Storyboard, shots: Shot[], panelId: string): (AudioClip & { scene: SceneClip })[] {
  const starts = panelStarts(sb, shots), base = starts.get(panelId) ?? 0;
  return (sb.sound ?? []).flatMap((c) => {
    const at = clipStart(sb, shots, c, starts);
    return at === null ? [] : [{ id: c.id, kind: KIND[c.lane], file: c.file, start: at - base, gain: c.gain, scene: c }];
  });
}

/** Every clip in scene frames, for playing the whole scene. */
export function sceneClips(sb: Storyboard, shots: Shot[]): AudioClip[] {
  const starts = panelStarts(sb, shots);
  return (sb.sound ?? []).flatMap((c) => {
    const at = clipStart(sb, shots, c, starts);
    return at === null ? [] : [{ id: c.id, kind: KIND[c.lane], file: c.file, start: at, gain: c.gain }];
  });
}

/** Clips whose panel was deleted go with it. */
export const dropOrphanClips = (sb: Storyboard) => { if (sb.sound) sb.sound = sb.sound.filter((c) => sb.panels.some((p) => p.id === c.panel)); };

/** Projects from before scene sound kept clips on each shot. Move them onto the scene, in the same place. */
export function moveShotSoundToScene(sb: Storyboard, shots: Shot[], makeId: () => string) {
  for (const shot of shots) {
    if (!shot.audio?.length) continue;
    const panel = sb.panels.find((p) => p.shot === shot.name);
    if (!panel) continue;
    sb.sound ??= [];
    for (const c of shot.audio) {
      const speaker = shot.actors.find((a) => a.id === c.actor)?.character;
      const lane: Lane = c.kind === 'music' ? 'music' : c.kind === 'sfx' ? 'sfx' : 'voice';
      sb.sound.push({ id: c.id || makeId(), lane, file: c.file, panel: panel.id, offset: c.start, gain: c.gain, speaker });
    }
    shot.audio = [];
  }
  // Clips that started before their shot's first frame belong in the panel before.
  for (const c of sb.sound ?? []) if (c.offset < 0) { const at = clipStart(sb, shots, c); if (at !== null) placeClip(sb, shots, c, at); }
}
