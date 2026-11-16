// The app: three screens. The storyboard is home; a panel opens in Act it out; Characters is where joints are set.
import './style.css';
import { newStoryboard, type Panel } from './model/storyboard';
import { emptyProject, filesToProject, projectToFiles, slug, type InFile, type Project } from './project/project';
import {
  canUseFolders, fromZip, loadFromBrowser, pickFolder, readFolder, saveToBrowser, toZip, writeFolder,
} from './project/store';
import { pictures } from './render/thumb';
import { ActView } from './ui/act';
import { CharactersView } from './ui/characters';
import { h } from './ui/dom';
import { mountImporter, type Imported, type ImportMode } from './ui/importer';
import { installPopovers } from './ui/motion';
import { addSample } from './ui/sample';
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
  if (import.meta.env.DEV) Object.assign(window, { __sb: null, __act: null, __chars: null });
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

function showAct(panel: Panel) {
  close();
  const sb = project.storyboard!;
  remember(`panel:${panel.id}`);
  const view = new ActView(app, {
    project, panel, number: sb.panels.indexOf(panel) + 1, onChanged: save,
    back: () => showStoryboard(),
    characters: () => { returnTo = panel; showCharacters(); },
  });
  screen = view;
  if (import.meta.env.DEV) Object.assign(window, { __act: view });
}

function showCharacters(show?: string) {
  close();
  remember('characters');
  const back = returnTo;
  const view = new CharactersView(app, {
    project, onChanged: save, show,
    back: () => (back && project.storyboard?.panels.includes(back) ? showAct(back) : showStoryboard()),
    importCharacter: showImporter,
  });
  screen = view;
  if (import.meta.env.DEV) Object.assign(window, { __chars: view });
}

function showImporter() {
  close();
  mountImporter(app, addCharacter, () => showCharacters());
}

function addCharacter(data: Imported, files: InFile[], mode: ImportMode) {
  const entry = { name: data.rig.name, mode, files, data };
  const at = project.characters.findIndex((c) => c.name === entry.name);
  if (at >= 0) project.characters[at] = entry; else project.characters.push(entry); // same name = updated art
  pictures.forget(entry.name);
  save();
  showCharacters(entry.name);
}

function showStart() {
  close();
  mountStart(app, { onNew: () => void newScene(), onOpenFolder: canUseFolders() ? openFolder : undefined, onOpenZip: pickZip });
}

/** A fresh scene with the sample panels. */
async function newScene() {
  close();
  message('Setting up a new scene…');
  project = emptyProject();
  project.storyboard = newStoryboard('Untitled scene');
  folder = null;
  try { project.storyboard.panels.push(...await addSample(project)); } catch { /* an empty scene is fine */ }
  showStoryboard();
}

async function loadProject(files: Map<string, Uint8Array>, from: string) {
  close();
  message(`Opening ${from}…`);
  try {
    const next = await filesToProject(files, message);
    if (!next.characters.length && !next.storyboard) throw new Error(`No scene found in ${from}.`);
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
  { label: 'New scene', run: () => void newScene() },
  ...(canUseFolders() ? [
    { label: folder ? `Saving to folder “${folder.name}”. Choose another…` : 'Save to a folder…', run: async () => { const picked = await pickFolder(); if (picked) { folder = picked; save(); } } },
    { label: 'Open a scene folder…', run: openFolder },
  ] : []),
  { label: 'Export scene as zip', run: () => download(`${slug(project.storyboard?.name ?? 'scene')}.zip`, toZip(projectToFiles(project)), 'application/zip') },
  { label: 'Open a scene zip…', run: pickZip },
];

async function boot() {
  if (import.meta.env.DEV) {
    // For scripts/make-placeholder-psd.mjs. Stripped from the built app.
    const { exportViewPsd } = await import('./dev/exportPsd');
    Object.assign(window, { __exportViewPsd: exportViewPsd, __project: () => project });
  }
  const stored = await loadFromBrowser();
  if (stored) {
    message('Opening your scene…');
    try { project = await filesToProject(stored, message); } catch { project = emptyProject(); }
  }
  if (!project.storyboard && !project.characters.length) { showStart(); return; }
  ensureStoryboard();
  // Reopen where you were.
  const where = remembered();
  const panel = where?.startsWith('panel:') ? project.storyboard!.panels.find((p) => p.id === where.slice(6)) : undefined;
  if (panel) showAct(panel);
  else if (where === 'characters') showCharacters();
  else showStoryboard();
}
boot();
