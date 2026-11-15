import './style.css';
import { emptyProject, filesToProject, projectToFiles, type InFile, type Project } from './project/project';
import {
  canUseFolders, fromZip, loadFromBrowser, pickFolder, readFolder, saveToBrowser, toZip, writeFolder,
} from './project/store';
import { h } from './ui/dom';
import { Editor } from './ui/editor';
import { installPopovers } from './ui/motion';
import { mountImporter, type Imported, type ImportMode } from './ui/importer';

const app = document.getElementById('app')!;
let project: Project = emptyProject();
let editor: Editor | null = null;
let shotName: string | undefined;
let folder: FileSystemDirectoryHandle | null = null;
let savedInBrowser = true;
let saveTimer = 0;
let saving = false;
installPopovers();

/** The short save state in the top bar. Plain text, no motion: it changes after every edit. */
const saveState = () => (saving ? 'Saving…' : savedInBrowser || folder ? 'Saved ✓' : 'Not saved');
const showSaveState = () => { const el = document.getElementById('save-state'); if (el) el.textContent = saveState(); };

const message = (text: string) => app.replaceChildren(h('main', { class: 'importer' }, h('p', { class: 'status', role: 'status' }, text)));

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

function closeEditor() {
  if (editor) shotName = editor.shot.name;
  editor?.dispose();
  editor = null;
  if (import.meta.env.DEV) Object.assign(window, { __rig: null });
}

function showImporter() {
  closeEditor();
  mountImporter(app, addCharacter, project.characters.length ? () => openEditor() : undefined);
}

function addCharacter(data: Imported, files: InFile[], mode: ImportMode) {
  const entry = { name: data.rig.name, mode, files, data };
  const at = project.characters.findIndex((c) => c.name === entry.name);
  if (at >= 0) project.characters[at] = entry; else project.characters.push(entry); // same name = updated art
  save();
  // New art goes straight onto the stage; updated art is already there.
  const onStage = project.shots.find((s) => s.name === shotName)?.actors.some((a) => a.character === entry.name);
  openEditor(onStage ? undefined : entry.name);
}

async function loadProject(files: Map<string, Uint8Array>, from: string) {
  closeEditor();
  message(`Opening ${from}…`);
  try {
    const next = await filesToProject(files, message);
    if (!next.characters.length && !next.poses.length && !next.pads.length) throw new Error(`No project found in ${from}.`);
    project = next;
    shotName = undefined;
    save();
  } catch (err) {
    message(err instanceof Error ? err.message : String(err));
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (project.characters.length) openEditor(); else showImporter();
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

const menu = () => [
  { label: 'Import a character…', run: showImporter },
  ...(canUseFolders() ? [
    {
      label: folder ? `Saving to folder “${folder.name}”. Choose another…` : 'Save to a folder…',
      run: async () => { const picked = await pickFolder(); if (picked) { folder = picked; save(); editor?.renderToolbar(); } },
    },
    {
      label: 'Open a project folder…',
      run: async () => { const picked = await pickFolder(); if (picked) { folder = picked; await loadProject(await readFolder(picked), picked.name); } },
    },
  ] : []),
  { label: 'Export project as zip', run: () => download('rig-project.zip', toZip(projectToFiles(project)), 'application/zip') },
  { label: 'Open a project zip…', run: pickZip },
];

async function openEditor(addCharacterNamed?: string) {
  closeEditor();
  editor = await Editor.mount(app, {
    project, shotName, addCharacter: addCharacterNamed,
    onChanged: save,
    onShot: (name) => { closeEditor(); shotName = name; openEditor(); },
    importCharacter: showImporter, download, menu,
    saveState,
    status: () => (folder ? `Saving to “${folder.name}”` : savedInBrowser ? 'Saved in this browser' : 'Not saved: browser storage is off'),
  });
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
    message('Opening your project…');
    try { project = await filesToProject(stored, message); } catch { project = emptyProject(); }
  }
  if (project.characters.length) openEditor(); else showImporter();
}
boot();
