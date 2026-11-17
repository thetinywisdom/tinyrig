// The app. The storyboard is home: its panels are scenes. A scene opens on Rig or Animate. Cast is the shared
// characters every scene starts from.
import './fonts.css';
import './style.css';
import { newStoryboard, type Panel } from './model/storyboard';
import { emptyProject, filesToProject, projectToFiles, slug, type InFile, type Project } from './project/project';
import {
  canUseFolders, fromZip, loadFromBrowser, pickFolder, readFolder, saveToBrowser, toZip, writeFolder,
} from './project/store';
import { pictures } from './render/thumb';
import { CharactersView } from './ui/characters';
import { h } from './ui/dom';
import { mountImporter, type Imported, type ImportMode } from './ui/importer';
import { installPopovers } from './ui/motion';
import { addSample } from './ui/sample';
import { SceneView, type SceneTab } from './ui/scene';
import { mountStart } from './ui/start';
import { StoryboardView } from './ui/storyboard';

const app = document.getElementById('app')!;
let project: Project = emptyProject();
let screen: { dispose(): void } | null = null;
let folder: FileSystemDirectoryHandle | null = null;
let savedInBrowser = true;
let saveTimer = 0;
let saving = false;
/** Where Characters goes back to: the storyboard, or the panel you came from. */
let returnTo: Panel | null = null;
installPopovers();

const saveState = () => (saving ? 'Saving…' : savedInBrowser || folder ? 'Saved ✓' : 'Not saved');
const showSaveState = () => { const el = document.getElementById('save-state'); if (el) el.textContent = saveState(); };
const status = () => (folder ? `Saving to “${folder.name}”` : savedInBrowser ? 'Saved in this browser' : 'Not saved: browser storage is off');
const message = (text: string) => app.replaceChildren(h('main', { class: 'importer' }, h('p', { class: 'status', role: 'status' }, text)));

/** Which screen to reopen after a reload. Per browser, not part of the project. */
const remember = (where: string | null) => { try { localStorage.setItem('rig.where', where ?? ''); } catch { /* storage off */ } };
const remembered = (): string | null => { try { return localStorage.getItem('rig.where') || null; } catch { return null; } };

/** Every change is saved to this browser, and to the project folder once one is chosen. */
function save() {
  clearTimeout(saveTimer);
  saving = true;
  showSaveState();
  saveTimer = window.setTimeout(async () => {
    const files = projectToFiles(project);
    savedInBrowser = await saveToBrowser(files);
    if (folder) {
      try { await writeFolder(folder, files); } catch { folder = null; }
    }
    saving = false;
    showSaveState();
  }, 400);
}

function close() {
  screen?.dispose();
  screen = null;
  if (import.meta.env.DEV) Object.assign(window, { __sb: null, __anim: null, __chars: null, __scene: null });
}
function ensureStoryboard() { project.storyboard ??= newStoryboard(); }

function showStoryboard() {
  close();
  ensureStoryboard();
  remember(null);
  returnTo = null;
  const view = new StoryboardView(app, {
    project, onChanged: save, openPanel: showAct, menu, saveState, status,
    characters: () => showCharacters(),
  });
  screen = view;
  if (import.meta.env.DEV) Object.assign(window, { __sb: view });
}

function showScene(panel: Panel, tab: SceneTab = 'animate') {
  close();
  remember(`panel:${panel.id}:${tab}`);
  const view = new SceneView(app, {
    project, panel, tab, onChanged: save, saveState, deleteCharacter,
    back: () => showStoryboard(),
    open: (p, t) => showScene(p, t),
    importCharacter: () => { returnTo = panel; showImporter(); },
  });
  screen = view;
  if (import.meta.env.DEV) Object.assign(window, { __scene: view });
}
const showAct = (panel: Panel) => showScene(panel, 'animate');

/** Delete a character from the cast and every scene. Returns a function that puts everything back. */
function deleteCharacter(name: string): (() => void) | null {
  const at = project.characters.findIndex((c) => c.name === name);
  if (at < 0) return null;
  const entry = project.characters[at];
  const panels = project.storyboard?.panels ?? [];
  const before = panels.map((p) => JSON.stringify({ cast: p.cast, lanes: p.lanes, stack: p.stack, rigs: p.rigs }));
  project.characters.splice(at, 1);
  for (const p of panels) {
    const gone = new Set((p.cast ?? []).filter((c) => c.character === name).map((c) => c.id));
    if (!gone.size && !p.rigs?.[name]) continue;
    p.cast = (p.cast ?? []).filter((c) => !gone.has(c.id));
    for (const id of gone) delete p.lanes?.[id];
    p.stack = p.stack?.filter((e) => !(e.kind === 'cast' && gone.has(e.id)));
    if (p.rigs) delete p.rigs[name];
  }
  pictures.forget(name);
  save();
  return () => {
    project.characters.splice(Math.min(at, project.characters.length), 0, entry);
    panels.forEach((p, i) => { const v = JSON.parse(before[i]); for (const k of ['cast', 'lanes', 'stack', 'rigs'] as const) { if (v[k] === undefined) delete p[k]; else (p as unknown as Record<string, unknown>)[k] = v[k]; } });
    pictures.forget(name);
    save();
  };
}

function showCharacters(show?: string) {
  close();
  remember('characters');
  const back = returnTo;
  const view = new CharactersView(app, {
    project, onChanged: save, show, deleteCharacter,
    back: () => (back && project.storyboard?.panels.includes(back) ? showScene(back, 'rig') : showStoryboard()),
    importCharacter: showImporter,
  });
  screen = view;
  if (import.meta.env.DEV) Object.assign(window, { __chars: view });
}

function showImporter() {
  close();
  const from = returnTo;
  mountImporter(app, addCharacter, () => (from && project.storyboard?.panels.includes(from) ? showScene(from, 'rig') : showCharacters()));
}

function addCharacter(data: Imported, files: InFile[], mode: ImportMode) {
  const entry = { name: data.rig.name, mode, files, data };
  const at = project.characters.findIndex((c) => c.name === entry.name);
  if (at >= 0) project.characters[at] = entry; else project.characters.push(entry); // same name = updated art
  pictures.forget(entry.name);
  save();
  // Imported from inside a scene: back to that scene's Rig tab, with the new character in it.
  const from = returnTo;
  if (from && project.storyboard?.panels.includes(from)) {
    returnTo = null;
    showScene(from, 'rig');
    return;
  }
  showCharacters(entry.name);
}

function showStart() {
  close();
  mountStart(app, { onNew: () => void newScene(), onOpenFolder: canUseFolders() ? openFolder : undefined, onOpenZip: pickZip });
}

/** A fresh scene with the sample panels. */
async function newScene() {
  close();
  message('Setting up a new episode…');
  project = emptyProject();
  project.storyboard = newStoryboard('Untitled episode');
  folder = null;
  try { project.storyboard.panels.push(...await addSample(project)); } catch { /* an empty scene is fine */ }
  showStoryboard();
}

async function loadProject(files: Map<string, Uint8Array>, from: string) {
  close();
  message(`Opening ${from}…`);
  try {
    const next = await filesToProject(files, message);
    if (!next.characters.length && !next.storyboard) throw new Error(`No episode found in ${from}. Choose the folder or zip this app saved.`);
    project = next;
    save();
  } catch (err) {
    message(err instanceof Error ? err.message : String(err));
    await new Promise((r) => setTimeout(r, 2500));
    if (!project.storyboard) { showStart(); return; }
  }
  showStoryboard();
}

function download(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function pickZip() {
  const input = h('input', {
    type: 'file', accept: '.zip',
    onchange: async () => {
      const file = input.files?.[0];
      if (file) loadProject(fromZip(new Uint8Array(await file.arrayBuffer())), file.name);
    },
  });
  input.click();
}
async function openFolder() {
  const picked = await pickFolder();
  if (picked) { folder = picked; await loadProject(await readFolder(picked), picked.name); }
}

const menu = () => [
  { label: 'New episode', run: () => void newScene() },
  ...(canUseFolders() ? [
    { label: folder ? `Saving to folder “${folder.name}”. Choose another…` : 'Save to a folder…', run: async () => { const picked = await pickFolder(); if (picked) { folder = picked; save(); } } },
    { label: 'Open an episode folder…', run: openFolder },
  ] : []),
  { label: 'Export episode as zip', run: () => download(`${slug(project.storyboard?.name ?? 'episode')}.zip`, toZip(projectToFiles(project)), 'application/zip') },
  { label: 'Open an episode zip…', run: pickZip },
];

async function boot() {
  if (import.meta.env.DEV) {
    // For scripts/make-placeholder-psd.mjs. Stripped from the built app.
    const { exportViewPsd } = await import('./dev/exportPsd');
    Object.assign(window, { __exportViewPsd: exportViewPsd, __project: () => project });
  }
  const stored = await loadFromBrowser();
  if (stored) {
    message('Opening your episode…');
    try { project = await filesToProject(stored, message); } catch { project = emptyProject(); }
  }
  if (!project.storyboard && !project.characters.length) { showStart(); return; }
  ensureStoryboard();
  // Reopen where you were.
  const where = remembered();
  const [, id, tab] = where?.startsWith('panel:') ? where.split(':') : [];
  const panel = id ? project.storyboard!.panels.find((p) => p.id === id) : undefined;
  if (panel) showScene(panel, tab === 'rig' ? 'rig' : 'animate');
  else if (where === 'characters') showCharacters();
  else showStoryboard();
}
boot();
