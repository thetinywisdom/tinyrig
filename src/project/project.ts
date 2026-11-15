// A project is a folder of plain files:
//   characters/<name>/source/<original files>   untouched art
//   characters/<name>/rig.json                  level, pivots, limits, draw order
//   poses/<name>.json  (+ .png thumbnail)       reusable on any character
//   controls/<name>.json                        controller pads
//   scenes/<name>.json                          scene templates
//   shots/<name>.json                           a scene plus its timeline, sound and text
//   backgrounds/ audio/ fonts/                  the files shots use
//   storyboard.json  sketches/                  the scene's panels and their sketches
// The same file map is written to a real folder, a zip, or the browser's own storage.
import type { Pad } from '../model/pads';
import type { SceneTemplate, Shot } from '../model/shot';
import type { Storyboard } from '../model/storyboard';
import type { Rig, SavedPose } from '../model/types';
import { readFiles, type Imported, type ImportMode } from '../ui/importer';

export interface InFile { name: string; data: ArrayBuffer }
export interface CharacterEntry { name: string; mode: ImportMode; files: InFile[]; data: Imported }
export interface Project {
  characters: CharacterEntry[];
  poses: SavedPose[];
  pads: Pad[];
  shots: Shot[];
  scenes: SceneTemplate[];
  /** The scene's panels. Null in a project made before the storyboard existed (one is made on opening). */
  storyboard: Storyboard | null;
  /** Background images, sketches, sound and font files, by project path (backgrounds/x.png, sketches/x.png, audio/x.wav, fonts/x.ttf). */
  assets: Map<string, Uint8Array>;
  /** Google Fonts families to load, by name. The only thing in the app that goes online, and only if used. */
  googleFonts: string[];
}
export type FileMap = Map<string, Uint8Array>;

export const emptyProject = (): Project => ({ characters: [], poses: [], pads: [], shots: [], scenes: [], storyboard: null, assets: new Map(), googleFonts: [] });
export const slug = (name: string) => name.trim().replace(/[^\w\- ]+/g, '_').replace(/\s+/g, '_') || 'untitled';
const enc = new TextEncoder(), dec = new TextDecoder();
const json = (value: unknown) => enc.encode(JSON.stringify(value, null, 2));

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function bytesDataUrl(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(s)}`;
}

export function projectToFiles(project: Project): FileMap {
  const files: FileMap = new Map();
  for (const c of project.characters) {
    const dir = `characters/${slug(c.name)}`;
    for (const f of c.files) files.set(`${dir}/source/${f.name}`, new Uint8Array(f.data));
    files.set(`${dir}/rig.json`, json({ ...c.data.rig, importMode: c.mode }));
  }
  for (const p of project.poses) {
    const { thumb, ...rest } = p;
    files.set(`poses/${slug(p.name)}.json`, json(rest));
    if (thumb) files.set(`poses/${slug(p.name)}.png`, dataUrlBytes(thumb));
  }
  for (const pad of project.pads) files.set(`controls/${slug(pad.name)}_${pad.id}.json`, json(pad));
  for (const shot of project.shots) files.set(`shots/${slug(shot.name)}.json`, json(shot));
  for (const scene of project.scenes) files.set(`scenes/${slug(scene.name)}.json`, json(scene));
  for (const [path, bytes] of project.assets) files.set(path, bytes);
  if (project.googleFonts.length) files.set('project.json', json({ googleFonts: project.googleFonts }));
  if (project.storyboard) files.set('storyboard.json', json(project.storyboard));
  return files;
}

/** Rebuild a project: re-read each character's source art, then put the saved rig back on top. */
export async function filesToProject(files: FileMap, onProgress?: (text: string) => void): Promise<Project> {
  const project = emptyProject();
  const parse = <T>(path: string): T | null => {
    try { return JSON.parse(dec.decode(files.get(path))) as T; } catch { return null; }
  };
  const dirs = new Set([...files.keys()].filter((p) => /^characters\/[^/]+\/rig\.json$/.test(p)).map((p) => p.split('/')[1]));
  for (const dir of dirs) {
    const saved = parse<Rig>(`characters/${dir}/rig.json`);
    const prefix = `characters/${dir}/source/`;
    const sources = [...files].filter(([p]) => p.startsWith(prefix)).map(([p, bytes]) => ({ name: p.slice(prefix.length), data: bytes.slice().buffer as ArrayBuffer }));
    if (!saved || !sources.length) continue;
    const mode: ImportMode = saved.importMode ?? 'whole';
    onProgress?.(`Reading ${saved.name}…`);
    const data = await readFiles(sources, mode, saved.name, (done, total) => onProgress?.(`Reading ${saved.name}… ${done} of ${total}`));
    // Keep the saved rig (dragged pivots, limits, order) when it still matches the art.
    const sameViews = Object.keys(saved.views).sort().join() === Object.keys(data.rig.views).sort().join();
    if (sameViews) data.rig = saved;
    data.rig.name = saved.name;
    project.characters.push({ name: saved.name, mode, files: sources, data });
  }
  for (const path of [...files.keys()].filter((p) => /^poses\/[^/]+\.json$/.test(p)).sort()) {
    const pose = parse<SavedPose>(path);
    if (!pose?.angles) continue;
    const png = files.get(path.replace(/\.json$/, '.png'));
    project.poses.push({ ...pose, tags: pose.tags ?? [], thumb: png ? bytesDataUrl(png) : undefined });
  }
  for (const path of [...files.keys()].filter((p) => /^controls\/[^/]+\.json$/.test(p)).sort()) {
    const pad = parse<Pad>(path);
    if (pad?.id && pad.slots) project.pads.push(pad);
  }
  for (const path of [...files.keys()].filter((p) => /^shots\/[^/]+\.json$/.test(p)).sort()) {
    const shot = parse<Shot>(path);
    if (shot?.actors) project.shots.push(shot);
  }
  for (const path of [...files.keys()].filter((p) => /^scenes\/[^/]+\.json$/.test(p)).sort()) {
    const scene = parse<SceneTemplate>(path);
    if (scene?.stage) project.scenes.push(scene);
  }
  for (const [path, bytes] of files) if (/^(backgrounds|sketches|audio|fonts)\//.test(path)) project.assets.set(path, bytes);
  const sb = parse<Storyboard>('storyboard.json');
  if (sb && Array.isArray(sb.panels)) project.storyboard = sb;
  project.googleFonts = parse<{ googleFonts?: string[] }>('project.json')?.googleFonts ?? [];
  return project;
}
