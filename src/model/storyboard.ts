// The storyboard: the scene as a grid of panels, read like a comic page.
// A project holds one scene. Each panel has a sketch, free-text notes and a duration,
// and, once it is animated, the shot that brings it to life. No DOM here.
import { FPS, type Shot } from './shot';

export interface Panel {
  id: string;
  /** Image file in the project's sketches/ folder. */
  sketch?: string;
  /** Everything else about the panel: dialogue, action, camera, sound. */
  notes: string;
  /** Seconds. When the panel has a shot, the shot's length wins. */
  duration: number;
  /** Name of the shot that animates this panel. */
  shot?: string;
  /** Part of the sample scene, removed by "Clear sample". */
  sample?: boolean;
}

export interface Storyboard {
  name: string;
  panels: Panel[];
  /** Show the original sketch on panels that are already animated. */
  showSketches?: boolean;
}

export const DEFAULT_DURATION = 3;
export const MIN_DURATION = 0.25;

export const newPanel = (id: string, fields: Partial<Panel> = {}): Panel => ({ id, notes: '', duration: DEFAULT_DURATION, ...fields });
export const newStoryboard = (name = 'Untitled scene'): Storyboard => ({ name, panels: [] });

const shotOf = (panel: Panel, shots: Shot[]) => (panel.shot ? shots.find((s) => s.name === panel.shot) : undefined);

/** Seconds, rounded to a tenth. A panel with a shot lasts as long as its shot. */
export function panelSeconds(panel: Panel, shots: Shot[]): number {
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

/** Header line: "1:48 · 27 shots". */
export function summary(sb: Storyboard, shots: Shot[]): string {
  const n = sb.panels.length;
  return `${formatRuntime(runtimeSeconds(sb, shots))} · ${n} ${n === 1 ? 'shot' : 'shots'}`;
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
