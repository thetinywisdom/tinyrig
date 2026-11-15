// Capture tab: pose the selected character from a photo, or from the webcam after a countdown.
import { h } from '../ui/dom';
import type { Editor } from '../ui/editor';
import { CAPTURE_GROUPS, landmarksToPose, type CaptureGroup, type Landmark } from './mapping';
import { detectPose } from './tracker';

const state = {
  stream: null as MediaStream | null,
  video: null as HTMLVideoElement | null,
  countdown: 0,
  photo: null as HTMLCanvasElement | null,
  points: null as Landmark[] | null,
  mirror: false,
  locked: new Set<CaptureGroup>(),
  message: '',
};

const BONES: [number, number][] = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [7, 8]];

/** The photo with the tracked skeleton drawn on it, so a bad track is obvious. */
function picture(): HTMLCanvasElement {
  const src = state.photo!, out = document.createElement('canvas');
  const k = 280 / src.width;
  out.width = 280; out.height = Math.round(src.height * k);
  const g = out.getContext('2d')!;
  g.drawImage(src, 0, 0, out.width, out.height);
  if (state.points) {
    g.lineWidth = 3; g.strokeStyle = '#e4572e'; g.fillStyle = '#ffffff';
    for (const [a, b] of BONES) {
      const p = state.points[a], q = state.points[b];
      if (p.visibility < 0.5 || q.visibility < 0.5) continue;
      g.beginPath(); g.moveTo(p.x * k, p.y * k); g.lineTo(q.x * k, q.y * k); g.stroke();
    }
    for (const i of new Set(BONES.flat())) {
      const p = state.points[i];
      if (p.visibility < 0.5) continue;
      g.beginPath(); g.arc(p.x * k, p.y * k, 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
  return out;
}

/** Pose the selected character from the tracked points. */
export function applyCapture(ed: Editor): boolean {
  const actor = ed.sel(), view = ed.view(), pose = ed.pose();
  if (!actor || !view || !pose || !state.points) return false;
  const result = landmarksToPose(state.points, view, ed.unlocked(), pose.angles, { mirror: state.mirror, locked: state.locked });
  Object.assign(pose.angles, result.angles);
  if (result.rootAngle !== null) pose.rootAngle = result.rootAngle;
  pose.flip = false;
  ed.edited();
  state.message = result.seen < 4 ? 'Only a few body parts were visible, so most of the pose was left as it was.' : 'Pose applied. Tweak it in the Animate tab.';
  return true;
}

const canWebcam = 'mediaDevices' in navigator;

export function stopWebcam() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.video = null;
  state.countdown = 0;
}

const grab = (video: HTMLVideoElement): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  const k = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight, 1));
  c.width = Math.max(1, Math.round(video.videoWidth * k)); c.height = Math.max(1, Math.round(video.videoHeight * k));
  c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
  return c;
};

async function startWebcam(ed: Editor) {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = state.stream;
    await video.play();
    state.video = video;
    state.message = 'Webcam on. Step back so your whole body shows, then start the countdown.';
  } catch {
    stopWebcam();
    state.message = 'The webcam could not be started. Allow camera access for this page in the browser, or use a photo.';
  }
  ed.renderPanel();
}

/** 3-2-1, then several frames in a row are tracked and averaged, which steadies a jittery track into one clean pose. */
async function countdownCapture(ed: Editor) {
  const video = state.video;
  if (!video || state.countdown) return;
  for (state.countdown = 3; state.countdown > 0; state.countdown--) {
    state.message = `Hold the pose… ${state.countdown}`;
    ed.renderPanel();
    await new Promise((r) => setTimeout(r, 1000));
    if (state.video !== video) return; // stopped meanwhile
  }
  state.message = 'Capturing…';
  ed.renderPanel();
  try {
    const runs: Landmark[][] = [];
    let last = grab(video);
    for (let i = 0; i < 5; i++) {
      last = grab(video);
      const pts = await detectPose(last, last.width, last.height);
      if (pts) runs.push(pts);
      await new Promise((r) => setTimeout(r, 60));
    }
    state.photo = last;
    state.points = runs.length ? runs[0].map((_, i) => ({
      x: runs.reduce((s, r) => s + r[i].x, 0) / runs.length, y: runs.reduce((s, r) => s + r[i].y, 0) / runs.length,
      visibility: runs.reduce((s, r) => s + r[i].visibility, 0) / runs.length,
    })) : null;
    if (!state.points) state.message = 'No person found. Make sure your whole body is in view and well lit.';
    else if (!applyCapture(ed)) state.message = 'Pose captured. Select a character to pose.';
  } catch (err) {
    state.points = null;
    state.message = `The tracker could not start. ${err instanceof Error ? err.message : ''}`;
  }
  ed.refresh();
}

export function capturePanel(ed: Editor): (Node | null)[] {
  const actor = ed.sel();
  const load = () => {
    const input = h('input', {
      type: 'file', accept: 'image/*',
      onchange: async () => {
        const file = input.files?.[0];
        if (!file) return;
        state.message = 'Looking for a person in the photo…';
        ed.renderPanel();
        try {
          const bitmap = await createImageBitmap(file);
          const canvas = document.createElement('canvas');
          const k = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
          canvas.width = Math.round(bitmap.width * k); canvas.height = Math.round(bitmap.height * k);
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          state.photo = canvas;
          state.points = await detectPose(canvas, canvas.width, canvas.height);
          if (!state.points) state.message = 'No person found in this photo. Try one that shows the whole body, facing the camera.';
          else if (!applyCapture(ed)) state.message = 'Person found. Select a character to pose.';
        } catch (err) {
          state.points = null;
          state.message = `Could not read the photo or start the tracker. ${err instanceof Error ? err.message : ''}`;
        }
        ed.refresh();
      },
    });
    input.click();
  };
  const reapply = () => { if (applyCapture(ed)) ed.refresh(); else ed.renderPanel(); };

  return [
    h('section', {},
      h('h3', {}, 'Pose from a photo'),
      h('p', { class: 'meta' }, 'Load a photo of someone in the pose you want, whole body, facing the camera. The tracker runs on this computer; the photo is not uploaded or saved. The result is a starting pose for you to tweak.'),
      h('button', { class: 'primary', id: 'load-photo', disabled: !actor, onclick: load }, 'Load a photo…'),
      actor ? null : h('p', { class: 'meta' }, 'Select a character first.'),
      h('p', { class: 'status', id: 'capture-status', role: 'status' }, state.message),
      state.photo ? h('div', { class: 'preview' }, picture()) : null),
    state.points ? h('section', {},
      h('h3', {}, 'Options'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'capture-mirror', checked: state.mirror, onchange: (e: Event) => { state.mirror = (e.target as HTMLInputElement).checked; reapply(); } }), 'Mirror (copy the pose like a mirror)'),
      h('p', { class: 'meta' }, 'Leave these parts as they are:'),
      h('div', { class: 'locks' }, CAPTURE_GROUPS.map(([id, text]) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.locked.has(id), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) state.locked.add(id); else state.locked.delete(id); } }), text))),
      h('button', { id: 'apply-capture', disabled: !actor, onclick: reapply }, `Apply to ${actor?.character ?? 'the selected character'} again`)) : null,
    h('section', {},
      h('h3', {}, 'Pose from the webcam'),
      h('p', { class: 'meta' }, 'Act the pose yourself. After a 3-2-1 countdown the app takes one steady pose from the picture. Nothing is recorded or uploaded.'),
      state.video
        ? h('div', { class: 'stack' },
            h('div', { class: 'preview webcam' }, state.video),
            h('button', { class: 'primary', id: 'webcam-capture', disabled: !actor || state.countdown > 0, onclick: () => countdownCapture(ed) }, state.countdown ? `${state.countdown}…` : 'Capture in 3 seconds'),
            h('button', { id: 'webcam-stop', onclick: () => { stopWebcam(); state.message = ''; ed.renderPanel(); } }, 'Turn the webcam off'))
        : h('button', { id: 'webcam-start', disabled: !canWebcam, onclick: () => startWebcam(ed) }, 'Turn the webcam on'),
      canWebcam ? null : h('p', { class: 'meta' }, 'This browser or page cannot use a webcam. Photos still work.')),
  ];
}
