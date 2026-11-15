// Copies the body-tracking engine from node_modules into public/, so the app serves it itself.
// Runs after `npm install`. The model file (public/models/pose_landmarker_lite.task) ships with the project.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = join(root, 'public', 'mediapipe');
if (existsSync(from)) {
  mkdirSync(to, { recursive: true });
  for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) cpSync(join(from, f), join(to, f));
  console.log('Tracker engine copied to public/mediapipe');
}
if (!existsSync(join(root, 'public', 'models', 'pose_landmarker_lite.task'))) {
  console.warn('Missing public/models/pose_landmarker_lite.task: the Capture tab will not work until it is restored.');
}
