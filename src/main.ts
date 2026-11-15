import './style.css';
import { FPS, newShot } from './model/shot';
import { freeShotName, linkShots, newPanel, newStoryboard, type Panel } from './model/storyboard';
import { emptyProject, filesToProject, projectToFiles, slug, type InFile, type Project } from './project/project';
import {
  canUseFolders, fromZip, loadFromBrowser, pickFolder, readFolder, saveToBrowser, toZip, writeFolder,
} from './project/store';
import { uid } from './model/shot';
import { h } from './ui/dom';
import { Editor } from './ui/editor';
import { installPopovers } from './ui/motion';
import { mountImporter, type Imported, type ImportMode } from './ui/importer';
import { addSample } from './ui/sample';
import { mountStart } from './ui/start';
import { StoryboardView } from './ui/storyboard';

const app = document.getElementById('app')!;
let project: Project = emptyProject();
let editor: Editor | null = null;
let board: StoryboardView | null = null;
let shotName: string | undefined;
let folder: FileSystemDirectoryHandle | null = null;
let savedInBrowser = true;
let saveTimer = 0;
let saving = false;
/** Where an imported character goes: into the open shot, or into a panel of the storyboard (null: a new panel). */
let importInto: { to: 'editor' } | { to: 'panel'; panelId: string | null } = { to: 'editor' };
installPopovers();

/** The short save state in the top bar. Plain text, no motion: it changes after every edit. */
const saveState = () => (saving ? 'Saving…' : savedInBrowser || folder ? 'Saved ✓' : 'Not saved');
const showSaveState = () => { const el = document.getElementById('save-state'); if (el) el.textContent = saveState(); };
const status = () => (folder ? `Saving to “${folder.name}”` : savedInBrowser ? 'Saved in this browser' : 'Not saved: browser storage is off');

const message = (text: string) => app.replaceChildren(h('main', { class: 'importer' }, h('p', { class: 'status', role: 'status' }, text)));

/** Which screen to reopen after a reload: the storyboard, or the shot that was open. Per browser, not part of the project. */
const remember = (shot: string | null) => { try { localStorage.setItem('rig.view', JSON.stringify({ shot })); } catch { /* storage off */ } };
const remembered = (): string | null => { try { return JSON.parse(localStorage.getItem('rig.view') ?? '{}').shot ?? null; } catch { return null; } };

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

function closeViews() {
  if (editor) shotName = editor.shot.name;
  editor?.dispose();
  editor = null;
  board?.dispose();
  board = null;
  if (import.meta.env.DEV) Object.assign(window, { __rig: null, __sb: null });
}

/** Every project has a storyboard; a project made before it existed gets one panel per shot. */
function ensureStoryboard() {
  if (!project.storyboard) project.storyboard = newStoryboard();
  linkShots(project.storyboard, project.shots, uid);
}

function showStoryboard() {
  closeViews();
  ensureStoryboard();
  remember(null);
  board = new StoryboardView(app, {
    project, onChanged: save, openPanel: (p) => openPanel(p), menu, saveState, status,
    importCharacter: (into) => { importInto = { to: 'panel', panelId: into?.id ?? null }; showImporter(); },
  });
  save();
  if (import.meta.env.DEV) Object.assign(window, { __sb: board });
}

function showStart() {
  closeViews();
  mountStart(app, {
    onNew: () => newScene(),
    onOpenFolder: canUseFolders() ? openFolder : undefined,
    onOpenZip: pickZip,
  });
}

/** A fresh scene with the sample panels. The scene it replaces can be brought back from the message. */
async function newScene() {
  const previous = project.storyboard || project.shots.length || project.characters.length ? project : null;
  closeViews();
  message('Setting up a new scene…');
  project = emptyProject();
  project.storyboard = newStoryboard('Untitled scene');
  folder = null;
  shotName = undefined;
  let failed = '';
  try { project.storyboard.panels.push(...await addSample(project)); } catch (err) { failed = err instanceof Error ? err.message : String(err); }
  showStoryboard();
  if (failed) board?.toast(`${failed} Started with an empty scene.`, false);
  else if (previous) {
    board?.toast('Started a new scene.', false);
    const undo = h('button', { class: 'link', id: 'restore-scene', onclick: () => { project = previous; shotName = undefined; showStoryboard(); } }, 'Bring back the last scene');
    document.querySelector('.toast')?.append(undo);
  }
}

/** Open a panel's shot, making one when the panel has none yet. */
function openPanel(panel: Panel, addCharacterNamed?: string) {
  const sb = project.storyboard!;
  let shot = panel.shot ? project.shots.find((s) => s.name === panel.shot) : undefined;
  if (!shot) {
    shot = newShot(freeShotName(`Shot ${sb.panels.indexOf(panel) + 1}`, project.shots));
    shot.length = Math.max(1, Math.round(panel.duration * FPS));
    project.shots.push(shot);
    panel.shot = shot.name;
    save();
  }
  shotName = shot.name;
  const onStage = shot.actors.some((a) => a.character === addCharacterNamed);
  openEditor(onStage ? undefined : addCharacterNamed);
}

function showImporter() {
  const back = editor ? () => openEditor() : () => showStoryboard();
  if (editor) importInto = { to: 'editor' };
  closeViews();
  mountImporter(app, addCharacter, back);
}

function addCharacter(data: Imported, files: InFile[], mode: ImportMode) {
  const entry = { name: data.rig.name, mode, files, data };
  const at = project.characters.findIndex((c) => c.name === entry.name);
  if (at >= 0) project.characters[at] = entry; else project.characters.push(entry); // same name = updated art
  if (importInto.to === 'panel') {
    // From the storyboard: the character goes into the chosen panel's shot, or a new panel at the end.
    ensureStoryboard();
    const sb = project.storyboard!;
    let panel = sb.panels.find((p) => p.id === (importInto as { panelId: string | null }).panelId);
    if (!panel) { panel = newPanel(uid()); sb.panels.push(panel); }
    importInto = { to: 'editor' };
    save();
    openPanel(panel, entry.name);
    return;
  }
  save();
  // New art goes straight onto the stage; updated art is already there.
  const onStage = project.shots.find((s) => s.name === shotName)?.actors.some((a) => a.character === entry.name);
  openEditor(onStage ? undefined : entry.name);
}

async function loadProject(files: Map<string, Uint8Array>, from: string) {
  closeViews();
  message(`Opening ${from}…`);
  try {
    const next = await filesToProject(files, message);
    if (!next.characters.length && !next.poses.length && !next.pads.length && !next.shots.length && !next.storyboard) throw new Error(`No scene found in ${from}.`);
    project = next;
    shotName = undefined;
    save();
  } catch (err) {
    message(err instanceof Error ? err.message : String(err));
    await new Promise((r) => setTimeout(r, 2500));
    if (!project.storyboard && !project.shots.length) { showStart(); return; }
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
  { label: 'Import a character…', run: () => { if (!editor) importInto = { to: 'panel', panelId: null }; showImporter(); } },
  ...(canUseFolders() ? [
    {
      label: folder ? `Saving to folder “${folder.name}”. Choose another…` : 'Save to a folder…',
      run: async () => { const picked = await pickFolder(); if (picked) { folder = picked; save(); editor?.renderToolbar(); } },
    },
    { label: 'Open a scene folder…', run: openFolder },
  ] : []),
  { label: 'Export scene as zip', run: () => download(`${slug(project.storyboard?.name ?? 'scene')}.zip`, toZip(projectToFiles(project)), 'application/zip') },
  { label: 'Open a scene zip…', run: pickZip },
];

async function openEditor(addCharacterNamed?: string) {
  closeViews();
  editor = await Editor.mount(app, {
    project, shotName, addCharacter: addCharacterNamed,
    onChanged: save,
    onShot: (name) => { closeViews(); shotName = name; openEditor(); },
    back: () => showStoryboard(),
    importCharacter: showImporter, download, menu,
    saveState, status,
  });
  remember(editor.shot.name);
  save();
  if (import.meta.env.DEV) {
    // Development hooks for the scripts in /scripts. Stripped from the built app.
    const { exportViewPsd } = await import('./dev/exportPsd');
    Object.assign(window, { __rig: editor, __exportViewPsd: exportViewPsd });
  }
}

async function boot() {
  const stored = await loadFromBrowser();
  if (stored) {
    message('Opening your scene…');
    try { project = await filesToProject(stored, message); } catch { project = emptyProject(); }
  }
  if (!project.storyboard && !project.shots.length && !project.characters.length) { showStart(); return; }
  // Reopen where you were: the shot that was open, or the storyboard.
  const shot = remembered();
  if (shot && project.shots.some((s) => s.name === shot)) { ensureStoryboard(); shotName = shot; openEditor(); } else showStoryboard();
}
boot();
