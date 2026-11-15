// Where the project's file map goes: the browser's own storage (always, so a
// reload loses nothing), a real folder (Chrome and Edge), or a zip (any browser).
import { unzipSync, zipSync } from 'fflate';
import type { FileMap } from './project';

const TOP_DIRS = ['characters', 'poses', 'controls', 'scenes', 'shots', 'backgrounds', 'audio', 'fonts'];
const ROOT_FILE = 'project.json';
const IN_PROJECT = new RegExp(`(^|/)((${TOP_DIRS.join('|')})/|${ROOT_FILE}$)`);

// --- browser storage (IndexedDB) ---------------------------------------------
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rig-animation-tool', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('project');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveToBrowser(files: FileMap): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('project', 'readwrite');
      tx.objectStore('project').put([...files], 'files');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch { return false; } // private window or blocked storage: the app still works, just without memory
}
export async function loadFromBrowser(): Promise<FileMap | null> {
  try {
    const db = await openDb();
    const value = await new Promise<[string, Uint8Array][] | undefined>((resolve, reject) => {
      const req = db.transaction('project').objectStore('project').get('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value?.length ? new Map(value) : null;
  } catch { return null; }
}

// --- real folder (File System Access API) ------------------------------------
type Dir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };
export const canUseFolders = () => 'showDirectoryPicker' in window;
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
  } catch { return null; } // cancelled, or not allowed here
}

async function listFolder(dir: Dir, prefix: string, out: Map<string, FileSystemFileHandle>) {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') await listFolder(handle as Dir, `${prefix}${name}/`, out);
    else out.set(prefix + name, handle as FileSystemFileHandle);
  }
}
async function projectFilesIn(root: FileSystemDirectoryHandle): Promise<Map<string, FileSystemFileHandle>> {
  const out = new Map<string, FileSystemFileHandle>();
  for (const top of TOP_DIRS) {
    try { await listFolder(await root.getDirectoryHandle(top) as Dir, `${top}/`, out); } catch { /* not there yet */ }
  }
  try { out.set(ROOT_FILE, await root.getFileHandle(ROOT_FILE)); } catch { /* none */ }
  return out;
}
export async function readFolder(root: FileSystemDirectoryHandle): Promise<FileMap> {
  const files: FileMap = new Map();
  for (const [path, handle] of await projectFilesIn(root)) files.set(path, new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  return files;
}

const written = new WeakMap<FileSystemDirectoryHandle, FileMap>();
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

/** Write changed files, and remove project files that no longer exist (a deleted pose). Only touches the project's own three folders. */
export async function writeFolder(root: FileSystemDirectoryHandle, files: FileMap) {
  const last = written.get(root) ?? new Map();
  for (const [path, bytes] of files) {
    if (same(last.get(path), bytes)) continue;
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    const stream = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
    await stream.write(bytes as unknown as BufferSource);
    await stream.close();
  }
  for (const path of (await projectFilesIn(root)).keys()) {
    if (files.has(path)) continue;
    const parts = path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    await dir.removeEntry(parts[parts.length - 1]);
  }
  written.set(root, new Map(files));
}

// --- zip -----------------------------------------------------------------------
export const toZip = (files: FileMap): Uint8Array => zipSync(Object.fromEntries(files), { level: 6 });
export function fromZip(bytes: Uint8Array): FileMap {
  const all = unzipSync(bytes);
  // Accept a zip whose project sits inside one top folder, as some unzip-and-rezip tools make.
  const paths = Object.keys(all).filter((p) => !p.endsWith('/'));
  const files: FileMap = new Map();
  for (const p of paths) {
    const i = p.search(IN_PROJECT);
    if (i >= 0) files.set(p.slice(i).replace(/^\//, ''), all[p]);
  }
  return files;
}
