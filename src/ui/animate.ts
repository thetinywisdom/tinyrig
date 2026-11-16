// Animate: one scene, on an endless canvas.
//   - Characters and images are layers, stacked front to back. Each character has a lane of poses you act out
//     from photos; each image shows for a stretch of time.
//   - The camera is a frame with the project's shape. Its lane holds keys; it moves or cuts into each one.
//     Only what is inside the frame is exported.
//   - The timeline along the bottom: solid black blocks for poses, light blocks for images, squares for keys.
import { bodyShown, BONES, DOTS, inPicture, poseFromPoints, standingPoints } from '../capture/act';
import type { Landmark } from '../capture/mapping';
import { detectPose } from '../capture/tracker';
import type { ActedPose } from '../model/act';
import {
  addCast, cameraAt, compileScene, frameHeight, laneTimes, newLanePose, sceneSeconds, sizeLabel, stackOf,
  type CameraCurve, type CameraKey, type ImageLayer, type LanePose, type ProjectSize, type StackEntry,
} from '../model/scene';
import { FPS, uid } from '../model/shot';
import { VIEWS, VIEW_LABEL, type ViewId } from '../model/skeleton';
import type { Panel } from '../model/storyboard';
import type { Rig, SavedPose } from '../model/types';
import type { Project } from '../project/project';
import { StageView } from '../render/stage';
import { finishedFrame, pictures, prepareStage } from '../render/thumb';
import { h } from './dom';
import { EASE_OUT, enter } from './motion';

export interface AnimateContext {
  project: Project;
  panel: Panel;
  size: () => ProjectSize;
  /** The rig a character uses in this scene (its scene tweak, or the shared one). */
  rigOf: (character: string) => Rig | null;
  onChanged: () => void;
  /** Go to the Rig tab (to add someone to the scene). */
  toRig: () => void;
}

type Sel =
  | { kind: 'pose'; cast: string; i: number }
  | { kind: 'lane'; cast: string }
  | { kind: 'camera'; id: string | null }
  | { kind: 'image'; id: string }
  | null;

const SVG = 'http://www.w3.org/2000/svg';
const fmt = (s: number) => `${(Math.round(s * 10) / 10).toFixed(1)}s`;
const snap = (s: number) => Math.max(0, Math.round(s * 10) / 10);
const CURVES: { id: CameraCurve; label: string; d: string }[] = [
  { id: 'smooth', label: 'Smooth', d: 'M2 22 C 16 22 24 2 38 2' },
  { id: 'linear', label: 'Linear', d: 'M2 22 L38 2' },
  { id: 'snap', label: 'Snap', d: 'M2 22 C 8 4 20 2 38 2' },
];

export class AnimateView {
  private p: Panel;
  private sel: Sel = null;
  /** The playhead, in seconds. */
  private t = 0;
  private stage = new StageView();
  private stageReady: Promise<void> | null = null;
  private loaded = new Set<string>();
  private fitted = false;
  private through = false;
  private playing = false;
  private raf = 0;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private photoUrls = new Map<string, string>();
  private busy = '';
  private disposers: (() => void)[] = [];
  private keep = new WeakMap<LanePose, { view?: ViewId; flip?: boolean }>();

  private root = h('div', { class: 'anim' });
  private left = h('section', { class: 'anim-pane anim-left' });
  private right = h('section', { class: 'anim-pane anim-right' });
  private stageBar = h('div', { class: 'act-label' });
  private stageHost = h('div', { class: 'anim-stage' });
  private marks = document.createElementNS(SVG, 'svg');
  private tl = h('div', { class: 'tl' });
  private photoBox = h('div', { class: 'act-photo' });
  private toastEl = h('div', { class: 'toast', role: 'status', hidden: true });
  private toastTimer = 0;

  constructor(host: HTMLElement, private ctx: AnimateContext) {
    this.p = ctx.panel;
    this.p.cast ??= [];
    this.p.lanes ??= {};
    const first = this.p.cast[0];
    if (first) this.sel = this.p.lanes[first.id]?.poses.length ? { kind: 'pose', cast: first.id, i: 0 } : { kind: 'lane', cast: first.id };
    this.marks.classList.add('anim-marks');
    this.right.append(this.stageBar, this.stageHost);
    this.root.append(h('div', { class: 'anim-main' }, this.left, this.right), this.tl, this.toastEl);
    host.replaceChildren(this.root);
    this.bindKeys();
    this.render();
  }

  private get size() { return this.ctx.size(); }
  private shot(t = this.t) { return compileScene(`scene:${this.p.id}`, this.p, this.size, { t, minSeconds: 0.5 }); }
  private seconds() { return sceneSeconds(this.p); }
  private castOf(id: string | null | undefined) { return this.p.cast!.find((c) => c.id === id) ?? null; }
  private rigOfCast(id: string | null | undefined) { const c = this.castOf(id); return c ? this.ctx.rigOf(c.character) : null; }
  private laneOf(castId: string) { return (this.p.lanes![castId] ??= { start: 0, poses: [] }); }
  /** The character you are acting for: the picked lane. */
  private get who(): string | null { return this.sel && (this.sel.kind === 'pose' || this.sel.kind === 'lane') ? this.sel.cast : null; }
  private selPose(): LanePose | null {
    const s = this.sel;
    return s?.kind === 'pose' ? this.p.lanes![s.cast]?.poses[s.i] ?? null : null;
  }

  // --- undo ----------------------------------------------------------------------------------
  private snapshot() {
    const { cast, lanes, images, stack, camera } = this.p;
    return JSON.stringify({ cast, lanes, images, stack, camera, sel: this.sel });
  }
  private change(run: () => void) {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    run();
    this.ctx.onChanged();
    this.render();
  }
  private restore(from: string[], to: string[]) {
    const s = from.pop();
    if (!s) return;
    to.push(this.snapshot());
    const v = JSON.parse(s);
    for (const k of ['cast', 'lanes', 'images', 'stack', 'camera'] as const) {
      if (v[k] === undefined) delete this.p[k]; else (this.p as unknown as Record<string, unknown>)[k] = v[k];
    }
    this.sel = v.sel;
    this.ctx.onChanged();
    this.render();
  }

  // --- the cast ------------------------------------------------------------------------------
  /** Put a character into the scene, standing in the middle of what the camera sees. */
  castCharacter(name: string): string | null {
    const rig = this.ctx.rigOf(name);
    return rig ? addCast(this.p, name, rig, this.size, this.t) : null;
  }

  // --- photos --------------------------------------------------------------------------------
  private photoUrl(file: string): string | null {
    const have = this.photoUrls.get(file);
    if (have) return have;
    const bytes = this.ctx.project.assets.get(`photos/${file}`);
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    this.photoUrls.set(file, url);
    return url;
  }
  private freeName(folder: string, name: string) {
    const clean = name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_') || 'photo.jpg';
    const dot = clean.lastIndexOf('.'), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '.jpg';
    let out = clean;
    for (let i = 2; this.ctx.project.assets.has(`${folder}/${out}`); i++) out = `${stem}-${i}${ext}`;
    return out;
  }

  /** Each photo becomes the next pose in the picked character's lane, in order. */
  async addPhotos(files: { name: string; bytes: Uint8Array }[], mirror = false) {
    if (!files.length) return;
    const castId = this.who;
    if (!castId) { this.say('Pick whose lane to act for first.'); return; }
    const rig = this.rigOfCast(castId);
    if (!rig) return;
    this.busy = files.length > 1 ? `Finding you in ${files.length} photos…` : 'Finding you in the photo…';
    this.render();
    const lane = this.laneOf(castId);
    const at = this.sel?.kind === 'pose' ? this.sel.i + 1 : lane.poses.length;
    const made: LanePose[] = [];
    let lost = 0;
    let prev: ActedPose | null = lane.poses[at - 1]?.pose ?? null;
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.bytes as unknown as BlobPart]));
      try {
        const img = new Image();
        await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('not an image')); img.src = url; });
        const w = img.naturalWidth, hgt = img.naturalHeight;
        let points: Landmark[] | null = null;
        try { points = await detectPose(img, w, hgt); } catch { points = null; }
        if (!points) { lost++; points = standingPoints(w, hgt); }
        const file = this.freeName('photos', f.name);
        this.ctx.project.assets.set(`photos/${file}`, f.bytes);
        const pose = poseFromPoints(points, rig, { mirror, size: { w, h: hgt }, current: prev ?? undefined });
        prev = pose;
        made.push(newLanePose(uid(), pose, { photo: file, size: { w, h: hgt }, points, mirror }));
      } catch {
        lost++;
      } finally { URL.revokeObjectURL(url); }
    }
    this.busy = '';
    if (!made.length) { this.render(); this.say('Those files could not be read as photos.'); return; }
    this.change(() => {
      lane.poses.splice(at, 0, ...made);
      this.sel = { kind: 'pose', cast: castId, i: at + made.length - 1 };
      this.t = laneTimes(lane)[at + made.length - 1].start;
    });
    if (lost) this.say(lost === made.length && lost === 1
      ? 'No person found in that photo. Drag the dots onto the body yourself.'
      : `${lost} of ${made.length} photos had no person the app could find. Drag their dots into place.`);
  }

  private pickFiles(accept: string, multiple: boolean, then: (files: { name: string; bytes: Uint8Array }[]) => void) {
    const input = h('input', {
      type: 'file', accept, multiple,
      onchange: async () => {
        const files = await Promise.all([...(input.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          .map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
        then(files);
      },
    });
    input.click();
  }
  private choosePhotos() { this.pickFiles('image/*', true, (f) => void this.addPhotos(f)); }

  /** A photo from the webcam after a short countdown. It copies you like the mirror the webcam shows. */
  private async webcamPhoto() {
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } }); } catch { this.say('The webcam is not available. Allow it for this page, or choose photos instead.'); return; }
    const video = h('video', { autoplay: true, muted: true, playsInline: true, class: 'cam-video' });
    video.srcObject = stream;
    const count = h('div', { class: 'cam-count', 'aria-live': 'assertive' });
    const close = () => { stream.getTracks().forEach((t) => t.stop()); overlay.remove(); };
    const shoot = h('button', { class: 'primary', id: 'cam-shoot' }, 'Take the photo in 3 seconds');
    const overlay = h('div', { class: 'cam', role: 'dialog', 'aria-label': 'Webcam' },
      h('div', { class: 'cam-frame' }, video, count),
      h('div', { class: 'cam-bar' }, h('span', { class: 'hint' }, 'Your whole body, or from the waist up. From the waist up, the legs keep their pose.'), h('span', { class: 'grow' }), h('button', { id: 'cam-close', onclick: close }, 'Close'), shoot));
    document.body.appendChild(overlay);
    enter(overlay.firstElementChild as HTMLElement, 'scale(0.98)', 200, EASE_OUT);
    shoot.addEventListener('click', async () => {
      shoot.disabled = true;
      for (let n = 3; n > 0; n--) { count.textContent = String(n); await new Promise((r) => setTimeout(r, 1000)); }
      count.textContent = '';
      const c = document.createElement('canvas');
      c.width = video.videoWidth || 1280; c.height = video.videoHeight || 720;
      const g = c.getContext('2d')!;
      g.translate(c.width, 0); g.scale(-1, 1); // as you see yourself
      g.drawImage(video, 0, 0, c.width, c.height);
      close();
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.9));
      if (blob) await this.addPhotos([{ name: 'webcam.jpg', bytes: new Uint8Array(await blob.arrayBuffer()) }], false);
    });
  }

  // --- changing a pose -----------------------------------------------------------------------
  /** Read the pose's photo again (after a dot moved, or the angle or flip changed). */
  private reapply(lp: LanePose, castId: string) {
    const rig = this.rigOfCast(castId);
    if (!rig || !lp.points) return;
    const keep = this.keep.get(lp) ?? {};
    lp.pose = poseFromPoints(lp.points, rig, { mirror: lp.mirror, size: lp.size, view: keep.view, flip: keep.flip, current: lp.pose });
  }
  private setKeep(lp: LanePose, castId: string, k: { view?: ViewId; flip?: boolean }) {
    this.keep.set(lp, { ...this.keep.get(lp), ...k });
    this.reapply(lp, castId);
  }
  private savePose() {
    const lp = this.selPose();
    if (!lp) return;
    const pose = lp.pose, name = `Pose ${this.ctx.project.poses.length + 1}`;
    const saved: SavedPose = { name, tags: [], view: pose.view, flip: pose.flip, rootAngle: pose.rootAngle, angles: { ...pose.angles }, swaps: pose.swaps };
    void pictures.picture(this.ctx.project, this.shot(), 160, Math.round(this.t * FPS)).then((url) => { saved.thumb = url; this.ctx.onChanged(); });
    this.ctx.project.poses.push(saved);
    this.ctx.onChanged();
    this.say(`Saved as "${name}". Use it from My poses in any scene.`);
  }
  private applySaved(sp: SavedPose) {
    const castId = this.who, rig = this.rigOfCast(castId);
    if (!castId || !rig) return;
    const pose: ActedPose = { view: rig.views[sp.view] ? sp.view : (VIEWS.find((v) => rig.views[v]) ?? 'front'), flip: sp.flip, rootAngle: sp.rootAngle, angles: { ...sp.angles }, swaps: sp.swaps };
    this.change(() => {
      const lp = this.selPose();
      if (lp) lp.pose = pose;
      else {
        const lane = this.laneOf(castId);
        lane.poses.push(newLanePose(uid(), pose));
        this.sel = { kind: 'pose', cast: castId, i: lane.poses.length - 1 };
      }
    });
  }

  // --- image layers --------------------------------------------------------------------------
  private addImages(files: { name: string; bytes: Uint8Array }[], at?: { x: number; y: number }) {
    void (async () => {
      const made: ImageLayer[] = [];
      for (const f of files) {
        const url = URL.createObjectURL(new Blob([f.bytes as unknown as BlobPart]));
        const img = new Image();
        try { await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(); img.src = url; }); } catch { this.say(`${f.name} is not an image the browser can show.`); continue; } finally { URL.revokeObjectURL(url); }
        const name = this.freeName('backgrounds', f.name);
        this.ctx.project.assets.set(`backgrounds/${name}`, f.bytes);
        // Fill what the camera sees, centred on the drop point (or the camera).
        const cam = cameraAt(this.p, this.size, this.t), fh = frameHeight(cam.width, this.size);
        const scale = Math.max(cam.width / img.naturalWidth, fh / img.naturalHeight);
        const c = at ?? { x: cam.x, y: cam.y };
        made.push({ id: uid(), file: name, scale, x: c.x - (img.naturalWidth * scale) / 2, y: c.y - (img.naturalHeight * scale) / 2 });
      }
      if (!made.length) return;
      this.change(() => {
        (this.p.images ??= []).push(...made);
        // New images go behind the characters, in front of the images already there.
        const stack = stackOf(this.p).filter((e) => !made.some((m) => m.id === e.id));
        const firstImage = stack.findIndex((e) => e.kind === 'image');
        stack.splice(firstImage < 0 ? stack.length : firstImage, 0, ...made.map((m): StackEntry => ({ kind: 'image', id: m.id })));
        this.p.stack = stack;
        this.sel = { kind: 'image', id: made.at(-1)!.id };
      });
    })();
  }
  private imageOf(id: string) { return this.p.images?.find((l) => l.id === id) ?? null; }

  // --- camera --------------------------------------------------------------------------------
  private keys() { return [...(this.p.camera ?? [])].sort((a, b) => a.t - b.t); }
  private keyAt(t: number) { return this.p.camera?.find((k) => Math.abs(k.t - t) < 0.05) ?? null; }
  /** The key at the playhead, made if there is none, starting from where the camera is now. */
  private keyHere(): CameraKey {
    const have = this.keyAt(this.t);
    if (have) return have;
    const at = cameraAt(this.p, this.size, this.t);
    const k: CameraKey = { id: uid(), t: snap(this.t), ...at, arrive: 'move', curve: 'smooth' };
    (this.p.camera ??= []).push(k);
    return k;
  }
  /** A quick framing around the cast at the playhead: everyone, or the picked character's upper body or face. */
  private quickShot(kind: 'wide' | 'medium' | 'close') {
    const boxes = this.p.cast!.map((c) => ({ id: c.id, b: this.stage.actor({ id: c.id, rig: this.rigOfCast(c.id)! })?.bounds() ?? null })).filter((x) => x.b);
    if (!boxes.length) { this.say('Put someone in the scene first.'); return; }
    const pick = boxes.find((x) => x.id === (this.lastCast ?? boxes[0].id)) ?? boxes[0];
    const r = kind === 'wide'
      ? boxes.reduce((a, { b }) => ({ x: Math.min(a.x, b!.x), y: Math.min(a.y, b!.y), r: Math.max(a.r, b!.x + b!.w), bt: Math.max(a.bt, b!.y + b!.h) }), { x: Infinity, y: Infinity, r: -Infinity, bt: -Infinity })
      : null;
    const b = pick.b!;
    const area = kind === 'wide' ? { x: r!.x, y: r!.y, w: r!.r - r!.x, h: r!.bt - r!.y, pad: 1.25 }
      : kind === 'medium' ? { x: b.x, y: b.y, w: b.w, h: b.h * 0.55, pad: 1.3 }
        : { x: b.x, y: b.y, w: b.w, h: b.h * 0.24, pad: 1.4 };
    const width = Math.max(area.w * area.pad, (area.h * area.pad * this.size.w) / this.size.h);
    this.change(() => {
      const k = this.keyHere();
      Object.assign(k, { x: area.x + area.w / 2, y: area.y + area.h / 2, width });
      this.sel = { kind: 'camera', id: k.id };
    });
  }
  private lastCast: string | null = null;

  // --- drawing -------------------------------------------------------------------------------
  render() {
    if (this.sel && (this.sel.kind === 'pose' || this.sel.kind === 'lane')) this.lastCast = this.sel.cast;
    this.renderLeft();
    this.renderStageBar();
    this.renderTimeline();
    void this.drawStage();
  }

  private renderLeft() {
    const s = this.sel;
    if (this.busy) { this.left.replaceChildren(h('div', { class: 'act-card' }, h('p', { class: 'act-busy', role: 'status' }, this.busy))); return; }
    if (!this.p.cast!.length) {
      const chars = this.ctx.project.characters;
      this.left.replaceChildren(h('div', { class: 'act-card' },
        h('h1', {}, 'Who is in this scene?'),
        h('p', { class: 'muted' }, chars.length ? 'Add someone from your cast, then act their poses out.' : 'Your cast is empty. Import a character first.'),
        h('div', { class: 'act-choices' }, chars.map((c) => h('button', { 'data-add-cast': c.name, onclick: () => this.change(() => { const id = this.castCharacter(c.name); if (id) this.sel = { kind: 'lane', cast: id }; }) }, `+ ${c.name}`)),
          h('button', { class: 'link', onclick: () => this.ctx.toRig() }, 'Open Rig'))));
      return;
    }
    if (s?.kind === 'camera') { this.renderCameraPanel(); return; }
    if (s?.kind === 'image') { this.renderImagePanel(s.id); return; }
    const castId = this.who ?? this.p.cast![0].id;
    const name = this.castOf(castId)?.character ?? '';
    const lp = this.selPose();
    if (!lp) {
      this.left.replaceChildren(h('div', { class: 'act-card' },
        h('h1', {}, `Act ${name}`),
        h('p', { class: 'muted' }, 'Do the pose yourself. The app finds your body, and the character copies it.'),
        h('div', { class: 'act-choices' },
          h('button', { class: 'primary big', id: 'act-webcam', onclick: () => void this.webcamPhoto() }, 'Use the webcam'),
          h('button', { class: 'big', id: 'act-photos', onclick: () => this.choosePhotos() }, 'Choose photos…')),
        h('div', { class: 'act-steps' },
          h('span', {}, h('b', {}, '1 · Act'), 'a photo, or several in order'),
          h('span', {}, h('b', {}, '2 · Check the dots'), 'drag any that are off'),
          h('span', {}, h('b', {}, '3 · The character'), 'copies you, in the same angle'))));
      return;
    }
    const lane = this.laneOf(castId), i = (s as { i: number }).i;
    this.left.replaceChildren(
      h('div', { class: 'act-label' }, h('b', {}, 'Your take'), h('span', { class: 'chip k' }, name), h('span', { class: 'muted px' }, `pose ${i + 1} of ${lane.poses.length}`),
        lp.points && bodyShown(lp.points, lp.size) === 'half' ? h('span', { class: 'pill', id: 'act-half', title: 'Parts outside the photo keep the pose they had' }, 'Waist up') : null,
        h('span', { class: 'grow' }), lp.points ? h('span', { class: 'hint px' }, 'Drag a dot the app got wrong') : null),
      this.photoBox,
      h('div', { class: 'act-bar' },
        h('button', { class: 'primary', id: 'act-more-webcam', onclick: () => void this.webcamPhoto() }, 'Webcam'),
        h('button', { id: 'act-more-photos', onclick: () => this.choosePhotos() }, 'Photos…'),
        lp.photo ? h('button', { id: 'act-retake', onclick: () => this.retake() }, 'Replace photo') : null,
        h('span', { class: 'grow' }),
        h('label', { class: 'act-num' }, h('span', {}, 'Hold'), h('input', {
          type: 'number', id: 'act-hold', min: 0, max: 20, step: 0.1, value: Math.round(lp.hold * 10) / 10,
          onchange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) this.change(() => { lp.hold = Math.max(0, Math.min(20, n)); }); },
        }), h('span', {}, 's')),
        h('button', { id: 'act-remove', onclick: () => this.removeSelected() }, 'Remove')));
    this.renderPhoto(lp, castId, i);
  }

  private renderCameraPanel() {
    const s = this.sel as { kind: 'camera'; id: string | null };
    const k = s.id ? this.p.camera?.find((x) => x.id === s.id) ?? null : null;
    const keys = this.keys(), idx = k ? keys.indexOf(k) : -1;
    const seg = <T extends string>(items: { id: T; label: string; extra?: Node }[], cur: T, set: (v: T) => void, attr: string) =>
      h('div', { class: 'tiles' }, items.map((it) => h('button', { class: cur === it.id ? 'selected' : '', [attr]: it.id, onclick: () => set(it.id) }, it.extra ?? null, h('span', { class: 'px' }, it.label))));
    this.left.replaceChildren(
      h('div', { class: 'act-label' }, h('b', {}, 'Camera'), h('span', { class: 'muted px' }, k ? `key ${idx + 1} of ${keys.length} · ${fmt(k.t)}` : `${keys.length} keys`)),
      k ? h('div', { class: 'cam-panel' },
        idx > 0 ? h('div', {}, h('h3', {}, 'Arrive by'),
          seg([{ id: 'move', label: 'Move' }, { id: 'cut', label: 'Cut' }], k.arrive, (v) => this.change(() => { k.arrive = v; }), 'data-arrive')) : h('p', { class: 'muted' }, 'The first key: where the camera starts.'),
        idx > 0 && k.arrive === 'move' ? h('div', {}, h('h3', {}, 'The move'),
          seg(CURVES.map((c) => ({ id: c.id, label: c.label, extra: svgCurve(c.d) })), k.curve, (v) => this.change(() => { k.curve = v; }), 'data-curve')) : null,
        h('div', {}, h('h3', {}, 'Framing'),
          h('div', { class: 'kv' }, h('span', {}, 'Size'), h('b', { class: 'px' }, `${sizeLabel(this.size)} ${this.size.w}×${this.size.h}`)),
          h('div', { class: 'kv' }, h('span', {}, 'Frame width'), h('b', { class: 'px' }, `${Math.round(k.width)}`))),
        h('div', { class: 'act-bar' }, h('button', { id: 'cam-remove', onclick: () => this.removeSelected() }, 'Remove key')))
        : h('p', { class: 'muted' }, 'Move the playhead and drag the frame, or press + Key. The camera moves or cuts into each key.'),
      h('div', {}, h('h3', {}, 'Quick shots at the playhead'),
        h('div', { class: 'tiles' }, (['wide', 'medium', 'close'] as const).map((q) => h('button', { 'data-shot': q, onclick: () => this.quickShot(q) }, h('span', { class: 'px' }, q === 'close' ? 'Close-up' : q[0].toUpperCase() + q.slice(1)))))),
    );
  }

  private renderImagePanel(id: string) {
    const l = this.imageOf(id);
    if (!l) { this.sel = null; this.renderLeft(); return; }
    const total = Math.max(this.seconds(), 0.5);
    const num = (label: string, value: number, set: (n: number) => void, key: string) => h('label', { class: 'act-num' }, h('span', {}, label), h('input', {
      type: 'number', min: 0, max: 600, step: 0.1, value: Math.round(value * 10) / 10, 'data-field': key,
      onchange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) this.change(() => set(Math.max(0, n))); },
    }));
    this.left.replaceChildren(
      h('div', { class: 'act-label' }, h('b', {}, l.file), h('span', { class: 'chip' }, 'Image')),
      h('p', { class: 'muted' }, 'Drag it on the canvas to place it. Drag its lane up or down to change what is in front.'),
      h('div', { class: 'act-bar' },
        num('From', l.start ?? 0, (n) => { l.start = n; }, 'start'), num('To', l.end ?? total, (n) => { l.end = n; }, 'end'),
        num('Size %', l.scale * 100, (n) => { l.scale = Math.max(0.01, n / 100); }, 'scale')),
      h('div', { class: 'act-bar' }, h('button', { id: 'image-remove', onclick: () => this.removeSelected() }, 'Remove image')));
  }

  /** The photo with the body the app found: dots you can drag, joined by lines. */
  private renderPhoto(lp: LanePose, castId: string, i: number) {
    this.photoBox.replaceChildren();
    if (!lp.photo || !lp.points || !lp.size) { this.photoBox.append(h('p', { class: 'muted act-nophoto' }, 'This pose came from My poses, not a photo.')); return; }
    const size = lp.size, points = lp.points;
    const img = h('img', { src: this.photoUrl(lp.photo) ?? '', alt: `Photo for pose ${i + 1}`, draggable: false });
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'act-bones');
    svg.setAttribute('viewBox', `0 0 ${size.w} ${size.h}`);
    svg.setAttribute('aria-hidden', 'true');
    const frame = h('div', { class: 'act-photo-frame', style: `aspect-ratio:${size.w}/${size.h}` }, img, svg);
    const seen = () => inPicture(points, size);
    const drawBones = () => {
      const s2 = seen();
      svg.replaceChildren(...BONES.filter(([a, b]) => s2[a].visibility > 0.3 && s2[b].visibility > 0.3).map(([a, b]) => {
        const l = document.createElementNS(SVG, 'line');
        l.setAttribute('x1', String(points[a].x)); l.setAttribute('y1', String(points[a].y));
        l.setAttribute('x2', String(points[b].x)); l.setAttribute('y2', String(points[b].y));
        return l;
      }));
    };
    drawBones();
    const inside = seen();
    for (const d of DOTS) {
      const pt = points[d.i];
      if (!pt || inside[d.i].visibility === 0) continue;
      const dot = h('button', {
        class: 'act-dot' + (pt.visibility < 0.5 ? ' unsure' : '') + ((pt as Landmark & { moved?: boolean }).moved ? ' moved' : ''),
        'aria-label': `${d.name}${pt.visibility < 0.5 ? ' (not sure)' : ''}`, 'data-dot': d.i,
        style: `left:${(pt.x / size.w) * 100}%;top:${(pt.y / size.h) * 100}%`,
      });
      let before = '';
      dot.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; dot.setPointerCapture(e.pointerId); before = this.snapshot(); dot.classList.add('dragging'); });
      dot.addEventListener('pointermove', (e) => {
        if (!dot.hasPointerCapture(e.pointerId)) return;
        const r = frame.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
        Object.assign(points[d.i], { x: x * size.w, y: y * size.h, visibility: 1, moved: true });
        dot.style.left = `${x * 100}%`; dot.style.top = `${y * 100}%`;
        drawBones();
        this.reapply(lp, castId);
        void this.drawStage();
      });
      const end = (e: PointerEvent) => {
        if (!dot.hasPointerCapture(e.pointerId)) return;
        dot.releasePointerCapture(e.pointerId);
        dot.classList.remove('dragging');
        if (before && before !== this.snapshot()) { this.undoStack.push(before); this.redoStack = []; this.ctx.onChanged(); this.renderTimeline(); }
        before = '';
      };
      dot.addEventListener('pointerup', end);
      dot.addEventListener('pointercancel', end);
      frame.append(dot);
    }
    this.photoBox.append(frame);
  }

  private retake() {
    const s = this.sel;
    if (s?.kind !== 'pose') return;
    this.pickFiles('image/*', false, async (files) => {
      const lane = this.laneOf(s.cast), before = lane.poses.length, old = lane.poses[s.i];
      await this.addPhotos(files);
      if (lane.poses.length === before + 1) {
        const fresh = lane.poses.splice(s.i + 1, 1)[0];
        fresh.hold = old.hold; fresh.move = old.move;
        lane.poses[s.i] = fresh;
        this.sel = { kind: 'pose', cast: s.cast, i: s.i };
        this.ctx.onChanged();
        this.render();
      }
    });
  }

  private renderStageBar() {
    const s = this.sel, lp = this.selPose(), castId = this.who, rig = this.rigOfCast(castId);
    const views = rig ? VIEWS.filter((v) => rig.views[v]) : [];
    const poses = this.ctx.project.poses;
    const items: (Node | null)[] = [h('b', {}, s?.kind === 'camera' ? 'Camera' : 'Scene'), h('span', { class: 'muted px' }, `${fmt(this.t)} · ${sizeLabel(this.size)}`), h('span', { class: 'grow' })];
    if (s?.kind === 'camera') {
      items.push(
        h('button', { id: 'cam-through', class: this.through ? 'selected' : '', 'aria-pressed': String(this.through), onclick: () => { this.through = !this.through; this.fitted = false; this.renderStageBar(); void this.drawStage(); } }, 'See through camera'),
        h('button', { class: 'primary', id: 'cam-key', onclick: () => this.change(() => { const k = this.keyHere(); this.sel = { kind: 'camera', id: k.id }; }) }, '+ Key here'));
    } else if (lp && castId) {
      items.push(
        views.length > 1 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Angle' }, views.map((v) => h('button', {
          class: lp.pose.view === v ? 'selected' : '', 'data-view': v,
          onclick: () => this.change(() => { if (lp.points) this.setKeep(lp, castId, { view: v }); else lp.pose.view = v; }),
        }, VIEW_LABEL[v]))) : null,
        h('button', { id: 'act-flip', 'aria-pressed': String(lp.pose.flip), class: lp.pose.flip ? 'selected' : '', onclick: () => this.change(() => { if (lp.points) this.setKeep(lp, castId, { flip: !lp.pose.flip }); else lp.pose.flip = !lp.pose.flip; }) }, 'Flip'),
        h('button', { id: 'act-save-pose', onclick: () => this.savePose() }, 'Save pose'),
        poses.length ? h('details', { class: 'menu', id: 'act-my-poses' }, h('summary', {}, 'My poses'),
          h('div', { class: 'menu-items' }, poses.map((sp) => h('button', { class: 'pose-row', onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); this.applySaved(sp); } },
            sp.thumb ? h('img', { src: sp.thumb, alt: '' }) : h('span', { class: 'no-thumb' }), sp.name)))) : null);
    }
    items.push(h('button', { id: 'add-image', onclick: () => this.pickFiles('image/*', true, (f) => this.addImages(f)) }, '+ Image'),
      h('button', { id: 'fit-camera', onclick: () => { this.fitted = false; void this.drawStage(); } }, 'Fit'));
    this.stageBar.replaceChildren(...items.filter((n): n is Node => !!n));
  }

  // --- the canvas ----------------------------------------------------------------------------
  private async drawStage(time?: number) {
    if (!this.stageReady) {
      this.stageReady = this.stage.init(this.stageHost);
      const ready = this.stageReady;
      void ready.then(() => { this.stageHost.append(this.marks); this.bindStage(); });
      const obs = new ResizeObserver(() => void ready.then(() => requestAnimationFrame(() => { if (!this.disposed) { this.stage.app.resize(); void this.drawStage(); } })));
      obs.observe(this.stageHost);
      this.disposers.push(() => obs.disconnect());
    }
    await this.stageReady;
    if (this.disposed) return;
    const t = time ?? this.t;
    const shot = this.shot(t);
    await prepareStage(this.stage, this.ctx.project, shot, this.loaded);
    if (this.disposed) return;
    const cam = cameraAt(this.p, this.size, t);
    const frameRect = { x: cam.x - cam.width / 2, y: cam.y - frameHeight(cam.width, this.size) / 2, w: cam.width, h: frameHeight(cam.width, this.size) };
    if (!this.fitted || this.through || this.playing) {
      this.stage.fit(this.through || this.playing ? frameRect : { x: frameRect.x - frameRect.w * 0.35, y: frameRect.y - frameRect.h * 0.2, w: frameRect.w * 1.7, h: frameRect.h * 1.4 }, this.through || this.playing ? 0.96 : 0.9);
      this.fitted = true;
    }
    this.stage.draw(finishedFrame(this.ctx.project, shot, Math.min(shot.length - 1, Math.round(t * FPS))), null);
    this.stage.clearOverlay();
    this.drawMarks(frameRect);
  }

  /** The camera frame over the canvas: outside it is dimmed. With the camera lane picked, other keys show too. */
  private drawMarks(r: { x: number; y: number; w: number; h: number }) {
    const el = (tag: string, a: Record<string, string | number>) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); return e; };
    const tl = this.stage.worldToScreen({ x: r.x, y: r.y }), br = this.stage.worldToScreen({ x: r.x + r.w, y: r.y + r.h });
    const W = this.stageHost.clientWidth, H = this.stageHost.clientHeight;
    const camSel = this.sel?.kind === 'camera';
    const out: Element[] = [el('path', { class: 'dim' + (this.through || this.playing ? ' solid' : ''), 'fill-rule': 'evenodd', d: `M0 0H${W}V${H}H0Z M${tl.x} ${tl.y}H${br.x}V${br.y}H${tl.x}Z` })];
    if (camSel && !this.playing) {
      for (const k of this.keys()) {
        if (this.keyAt(this.t) === k) continue;
        const kh = frameHeight(k.width, this.size), a = this.stage.worldToScreen({ x: k.x - k.width / 2, y: k.y - kh / 2 }), b = this.stage.worldToScreen({ x: k.x + k.width / 2, y: k.y + kh / 2 });
        out.push(el('rect', { class: 'ghost', x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }));
      }
    }
    if (!this.playing) {
      out.push(el('rect', { class: 'frame' + (camSel ? ' sel' : ''), x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }));
      if (camSel) for (const [x, y] of [[tl.x, tl.y], [br.x, tl.y], [tl.x, br.y], [br.x, br.y]]) out.push(el('rect', { class: 'handle', x: x - 5, y: y - 5, width: 10, height: 10 }));
      const label = el('text', { class: 'flabel', x: tl.x, y: tl.y - 7 });
      label.textContent = `${sizeLabel(this.size)} ${this.size.w}×${this.size.h}`;
      out.push(label);
    }
    this.marks.replaceChildren(...out);
  }

  private bindStage() {
    const canvas = this.stage.canvas;
    const at = (e: PointerEvent | WheelEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2 && !e.shiftKey) this.stage.zoomAt(at(e), Math.exp(-e.deltaY * 0.0015));
      else this.stage.panBy(-e.deltaX, -e.deltaY);
      this.through = false;
      void this.drawStage();
    }, { passive: false });
    type Drag = { kind: 'pan'; last: { x: number; y: number } } | { kind: 'frame'; key: CameraKey; corner: number; from: { x: number; y: number }; start: { x: number; y: number; width: number }; before: string }
      | { kind: 'cast'; id: string; from: { x: number; y: number }; root: { x: number; y: number }; before: string } | { kind: 'image'; layer: ImageLayer; from: { x: number; y: number }; start: { x: number; y: number }; before: string };
    let drag: Drag | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const screen = at(e), world = this.stage.screenToWorld(screen);
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || e.altKey) { drag = { kind: 'pan', last: screen }; return; }
      const cam = cameraAt(this.p, this.size, this.t), fh = frameHeight(cam.width, this.size);
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => this.stage.worldToScreen({ x: cam.x + (sx * cam.width) / 2, y: cam.y + (sy * fh) / 2 }));
      const corner = corners.findIndex((c) => Math.hypot(c.x - screen.x, c.y - screen.y) < 12);
      const inFrame = Math.abs(world.x - cam.x) <= cam.width / 2 && Math.abs(world.y - cam.y) <= fh / 2;
      if (this.sel?.kind === 'camera' && (corner >= 0 || inFrame)) {
        const before = this.snapshot();
        const key = this.keyHere();
        this.sel = { kind: 'camera', id: key.id };
        drag = { kind: 'frame', key, corner, from: world, start: { x: key.x, y: key.y, width: key.width }, before };
        return;
      }
      const shot = this.shot();
      const order = shot.actors.map((a) => ({ id: a.id, rig: this.rigOfCast(a.id)! })).filter((a) => a.rig);
      const hit = this.stage.hitActor(order.sort((a, b) => (shot.order ?? []).indexOf(a.id) - (shot.order ?? []).indexOf(b.id)), world);
      if (hit) {
        const c = this.castOf(hit.id)!;
        const lane = this.laneOf(c.id);
        if (this.who !== c.id) { this.sel = lane.poses.length ? { kind: 'pose', cast: c.id, i: 0 } : { kind: 'lane', cast: c.id }; this.render(); }
        drag = { kind: 'cast', id: c.id, from: world, root: { ...c.root }, before: this.snapshot() };
        return;
      }
      const img = this.stage.hitBackground(shot.backgrounds.filter((b) => (b.start ?? 0) <= this.t * FPS && this.t * FPS < (b.end ?? Infinity)).sort((a, b) => (shot.order ?? []).indexOf(a.id) - (shot.order ?? []).indexOf(b.id)), world);
      const layer = img ? this.imageOf(img) : null;
      if (layer) {
        if (this.sel?.kind !== 'image' || this.sel.id !== layer.id) { this.sel = { kind: 'image', id: layer.id }; this.render(); }
        drag = { kind: 'image', layer, from: world, start: { x: layer.x, y: layer.y }, before: this.snapshot() };
        return;
      }
      drag = { kind: 'pan', last: screen };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const screen = at(e), world = this.stage.screenToWorld(screen);
      if (drag.kind === 'pan') { this.stage.panBy(screen.x - drag.last.x, screen.y - drag.last.y); drag.last = screen; this.through = false; }
      else if (drag.kind === 'frame') {
        const k = drag.key;
        if (drag.corner < 0) { k.x = drag.start.x + world.x - drag.from.x; k.y = drag.start.y + world.y - drag.from.y; }
        else {
          // Resize from a corner, keeping the shape: the opposite corner stays put.
          const sx = drag.corner % 2 ? 1 : -1, sy = drag.corner > 1 ? 1 : -1;
          const fh0 = frameHeight(drag.start.width, this.size);
          const ox = drag.start.x - (sx * drag.start.width) / 2, oy = drag.start.y - (sy * fh0) / 2;
          const w = Math.max(80, Math.max(Math.abs(world.x - ox), (Math.abs(world.y - oy) * this.size.w) / this.size.h));
          k.width = w; k.x = ox + (sx * w) / 2; k.y = oy + (sy * frameHeight(w, this.size)) / 2;
        }
      } else if (drag.kind === 'cast') {
        const c = this.castOf(drag.id)!;
        c.root = { x: drag.root.x + world.x - drag.from.x, y: drag.root.y + world.y - drag.from.y };
      } else if (drag.kind === 'image') {
        drag.layer.x = drag.start.x + world.x - drag.from.x; drag.layer.y = drag.start.y + world.y - drag.from.y;
      }
      void this.drawStage();
    });
    const end = () => {
      const d = drag;
      drag = null;
      if (!d || d.kind === 'pan') return;
      if (d.before !== this.snapshot()) { this.undoStack.push(d.before); this.redoStack = []; this.ctx.onChanged(); }
      this.render();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    // Drop images straight onto the canvas.
    this.stageHost.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); this.stageHost.classList.add('drop-over'); } });
    this.stageHost.addEventListener('dragleave', () => this.stageHost.classList.remove('drop-over'));
    this.stageHost.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.stageHost.classList.remove('drop-over');
      const list = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!list.length) return;
      const r = canvas.getBoundingClientRect(), world = this.stage.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
      this.addImages(await Promise.all(list.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))), world);
    });
  }

  // --- the timeline --------------------------------------------------------------------------
  private span() { return Math.max(4, Math.ceil(this.seconds() + 1)); }
  private renderTimeline() {
    const span = this.span(), pct = (s: number) => `${(s / span) * 100}%`;
    const rows: Node[] = [];
    const ticks: Node[] = [];
    for (let s = 0; s <= span; s += 0.5) ticks.push(h('span', { class: 'px', style: `left:${pct(s)}` }, `${s.toFixed(1)}s`));
    const ruler = h('div', { class: 'tl-ruler' }, ...ticks);
    rows.push(h('div', { class: 'px muted tl-head' }, 'layers'), ruler);
    const stack = stackOf(this.p);
    stack.forEach((entry, idx) => {
      if (entry.kind === 'cast') {
        const c = this.castOf(entry.id);
        if (!c) return;
        const lane = this.laneOf(c.id), times = laneTimes(lane);
        const on = this.who === c.id;
        rows.push(this.laneName(entry, idx, c.character, String(lane.poses.length), on));
        const blocks = lane.poses.map((lp, i) => {
          const sel = this.sel?.kind === 'pose' && this.sel.cast === c.id && this.sel.i === i;
          const b = h('div', { class: 'blk' + (sel ? ' on' : ''), 'data-pose': `${c.id}:${i}`, style: `left:${pct(times[i].start)};width:${pct(Math.max(0.05, lp.hold))}` },
            h('span', { class: 'px' }, String(i + 1).padStart(2, '0')), h('span', { class: 'px dur' }, fmt(lp.hold)), h('i', { class: 'edge' }));
          this.bindBlock(b, c.id, i, span);
          return b;
        });
        const add = h('button', { class: 'tl-add px', 'data-act': c.id, style: `left:calc(${pct(times.at(-1)?.holdEnd ?? lane.start)} + 6px)`, title: `Act ${c.character}'s next pose`, onclick: () => { this.sel = lane.poses.length ? { kind: 'pose', cast: c.id, i: lane.poses.length - 1 } : { kind: 'lane', cast: c.id }; this.render(); this.choosePhotos(); } }, '+');
        rows.push(this.laneTrack(h('div', { class: 'ln cast' + (on ? ' on' : ''), 'data-lane': c.id }, h('i', { class: 'track' }), ...blocks, add), (t) => { this.sel = lane.poses.length ? { kind: 'pose', cast: c.id, i: this.poseAt(c.id, t) } : { kind: 'lane', cast: c.id }; }));
      } else {
        const l = this.imageOf(entry.id);
        if (!l) return;
        const sel = this.sel?.kind === 'image' && this.sel.id === l.id;
        rows.push(this.laneName(entry, idx, l.file.replace(/\.[^.]+$/, ''), 'img', sel));
        const start = l.start ?? 0, end = l.end ?? span;
        const b = h('div', { class: 'img' + (sel ? ' on' : ''), 'data-image': l.id, style: `left:${pct(start)};width:${pct(Math.max(0.1, end - start))}` },
          h('span', { class: 'thumb', style: this.imageThumb(l.file) }), h('span', { class: 'px' }, l.file.replace(/\.[^.]+$/, '')), h('i', { class: 'edge l' }), h('i', { class: 'edge' }));
        this.bindImageBlock(b, l, span);
        rows.push(this.laneTrack(h('div', { class: 'ln' }, b), () => { this.sel = { kind: 'image', id: l.id }; }));
      }
    });
    // The camera: not a layer, so it sits apart.
    const camOn = this.sel?.kind === 'camera';
    rows.push(h('div', { class: 'tl-sep' }), h('div', { class: 'tl-sep' }));
    rows.push(h('button', { class: 'nm camname' + (camOn ? ' on' : ''), id: 'lane-camera', onclick: () => { this.sel = { kind: 'camera', id: this.keyAt(this.t)?.id ?? null }; this.render(); } }, h('span', { class: 'px' }, 'camera'), h('span', { class: 'px c' }, String(this.p.camera?.length ?? 0))));
    const keys = this.keys().map((k, i) => {
      const sel = this.sel?.kind === 'camera' && this.sel.id === k.id;
      const b = h('div', { class: 'key' + (k.arrive === 'cut' && i > 0 ? ' cut' : '') + (sel ? ' on' : ''), 'data-key': k.id, style: `left:${pct(k.t)}`, title: `${fmt(k.t)} · ${i === 0 ? 'start' : k.arrive}` });
      this.bindKey(b, k, span);
      return b;
    });
    const segs = this.keys().slice(1).map((k, i) => {
      const a = this.keys()[i];
      return h('i', { class: 'seg ' + k.arrive, style: `left:${pct(a.t)};width:${pct(k.t - a.t)}` });
    });
    rows.push(this.laneTrack(h('div', { class: 'ln camln' }, h('i', { class: 'track' }), ...segs, ...keys), () => { this.sel = { kind: 'camera', id: this.keyAt(this.t)?.id ?? null }; }));
    const playhead = h('i', { class: 'playhead', style: `left:${pct(this.t)}` });
    ruler.append(playhead);
    this.tl.replaceChildren(...rows);
    this.tl.style.setProperty('--rows', String(stack.length + 1));
    // Clicking the ruler moves the playhead.
    ruler.addEventListener('pointerdown', (e) => {
      const set = (ev: PointerEvent) => { const r = ruler.getBoundingClientRect(); this.t = snap(((ev.clientX - r.left) / r.width) * span); playhead.style.left = pct(this.t); void this.drawStage(); };
      ruler.setPointerCapture(e.pointerId);
      set(e);
      const move = (ev: PointerEvent) => set(ev);
      const up = () => { ruler.removeEventListener('pointermove', move); ruler.removeEventListener('pointerup', up); this.render(); };
      ruler.addEventListener('pointermove', move);
      ruler.addEventListener('pointerup', up);
    });
  }

  private poseAt(castId: string, t: number) {
    const times = laneTimes(this.laneOf(castId));
    let i = 0;
    while (i + 1 < times.length && times[i + 1].start <= t) i++;
    return i;
  }
  private imageThumb(file: string) {
    const bytes = this.ctx.project.assets.get(`backgrounds/${file}`);
    if (!bytes) return '';
    let url = this.photoUrls.get(`bg:${file}`);
    if (!url) { url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart])); this.photoUrls.set(`bg:${file}`, url); }
    return `background-image:url("${url}")`;
  }

  /** A lane's name: click to pick it; drag it up or down to change what is in front. */
  private laneName(entry: StackEntry, idx: number, label: string, count: string, on: boolean): HTMLElement {
    const el = h('div', { class: 'nm' + (on ? ' on' : ''), 'data-stack': `${entry.kind}:${entry.id}`, title: 'Drag up or down to change what is in front' },
      h('span', { class: 'px' }, label), h('span', { class: 'px c' }, count));
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      const y0 = e.clientY, rowH = el.getBoundingClientRect().height + 8;
      let moved = false;
      const move = (ev: PointerEvent) => { const dy = ev.clientY - y0; if (Math.abs(dy) > 4) moved = true; el.style.transform = `translateY(${dy}px)`; el.classList.add('lifted'); };
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        el.style.transform = ''; el.classList.remove('lifted');
        if (!moved) {
          this.sel = entry.kind === 'image' ? { kind: 'image', id: entry.id } : (this.laneOf(entry.id).poses.length ? { kind: 'pose', cast: entry.id, i: this.poseAt(entry.id, this.t) } : { kind: 'lane', cast: entry.id });
          this.render();
          return;
        }
        const stack = stackOf(this.p), to = Math.max(0, Math.min(stack.length - 1, idx + Math.round((ev.clientY - y0) / rowH)));
        if (to === idx) return;
        this.change(() => { const [it] = stack.splice(idx, 1); stack.splice(to, 0, it); this.p.stack = stack; });
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    return el;
  }
  private laneTrack(el: HTMLElement, pick: (t: number) => void): HTMLElement {
    el.addEventListener('pointerdown', (e) => {
      if (e.target !== el && !(e.target as HTMLElement).classList.contains('track')) return;
      const r = el.getBoundingClientRect();
      this.t = snap(((e.clientX - r.left) / r.width) * this.span());
      pick(this.t);
      this.render();
    });
    return el;
  }
  /** Click a pose to pick it; drag its body to slide it in time, its right edge to hold longer. */
  private bindBlock(b: HTMLElement, castId: string, i: number, span: number) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      const lane = this.laneOf(castId), lp = lane.poses[i];
      const edge = (e.target as HTMLElement).classList.contains('edge');
      const x0 = e.clientX, pxPerS = (b.parentElement!.getBoundingClientRect().width) / span;
      const before = this.snapshot(), hold0 = lp.hold, move0 = i > 0 ? lane.poses[i - 1].move : lane.start;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const ds = (ev.clientX - x0) / pxPerS;
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (!moved) return;
        if (edge) lp.hold = Math.max(0, snap(hold0 + ds));
        else if (i > 0) lane.poses[i - 1].move = Math.max(0.1, snap(move0 + ds));
        else lane.start = Math.max(0, snap(move0 + ds));
        // Move this block in place: rebuilding the timeline now would drop the pointer.
        const tm = laneTimes(lane)[i];
        b.style.left = `${(tm.start / span) * 100}%`; b.style.width = `${(Math.max(0.05, lp.hold) / span) * 100}%`;
        const dur = b.querySelector('.dur'); if (dur) dur.textContent = fmt(lp.hold);
      };
      const up = () => {
        b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up);
        if (moved) { if (before !== this.snapshot()) { this.undoStack.push(before); this.redoStack = []; this.ctx.onChanged(); } }
        this.sel = { kind: 'pose', cast: castId, i };
        this.t = laneTimes(lane)[i].start;
        this.render();
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up);
    });
  }
  private bindImageBlock(b: HTMLElement, l: ImageLayer, span: number) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      const t = e.target as HTMLElement, which = t.classList.contains('edge') ? (t.classList.contains('l') ? 'start' : 'end') : null;
      const x0 = e.clientX, pxPerS = b.parentElement!.getBoundingClientRect().width / span, before = this.snapshot();
      const s0 = l.start ?? 0, e0 = l.end ?? span;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const ds = (ev.clientX - x0) / pxPerS;
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (!moved) return;
        if (which === 'start') l.start = Math.min(e0 - 0.1, snap(s0 + ds));
        else if (which === 'end') l.end = Math.max(s0 + 0.1, snap(e0 + ds));
        else { const d = Math.max(-s0, ds); l.start = snap(s0 + d); l.end = snap(e0 + d); }
        b.style.left = `${((l.start ?? 0) / span) * 100}%`; b.style.width = `${(((l.end ?? span) - (l.start ?? 0)) / span) * 100}%`;
      };
      const up = () => {
        b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up);
        if (moved && before !== this.snapshot()) { this.undoStack.push(before); this.redoStack = []; this.ctx.onChanged(); }
        this.sel = { kind: 'image', id: l.id };
        this.render();
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up);
    });
  }
  private bindKey(b: HTMLElement, k: CameraKey, span: number) {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      const x0 = e.clientX, pxPerS = b.parentElement!.getBoundingClientRect().width / span, before = this.snapshot(), t0 = k.t;
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        if (!moved) return;
        k.t = snap(Math.max(0, t0 + (ev.clientX - x0) / pxPerS));
        b.style.left = `${(k.t / span) * 100}%`;
      };
      const up = () => {
        b.removeEventListener('pointermove', move); b.removeEventListener('pointerup', up);
        if (moved && before !== this.snapshot()) { this.undoStack.push(before); this.redoStack = []; this.ctx.onChanged(); }
        this.sel = { kind: 'camera', id: k.id };
        this.t = k.t;
        this.render();
      };
      b.addEventListener('pointermove', move);
      b.addEventListener('pointerup', up);
    });
  }

  private removeSelected() {
    const s = this.sel;
    if (!s) return;
    this.change(() => {
      if (s.kind === 'pose') {
        const lane = this.laneOf(s.cast);
        lane.poses.splice(s.i, 1);
        this.sel = lane.poses.length ? { kind: 'pose', cast: s.cast, i: Math.min(s.i, lane.poses.length - 1) } : { kind: 'lane', cast: s.cast };
      } else if (s.kind === 'camera' && s.id) {
        this.p.camera = this.p.camera?.filter((k) => k.id !== s.id);
        this.sel = { kind: 'camera', id: null };
      } else if (s.kind === 'image') {
        this.p.images = this.p.images?.filter((l) => l.id !== s.id);
        this.p.stack = this.p.stack?.filter((e) => e.id !== s.id);
        this.sel = null;
      }
    });
  }

  // --- playing -------------------------------------------------------------------------------
  play() {
    if (this.playing) { this.stopPlay(); return; }
    const total = this.seconds();
    if (total <= 0) return;
    this.playing = true;
    const from = this.t >= total ? 0 : this.t, t0 = performance.now();
    const tick = () => {
      if (!this.playing) return;
      const t = from + (performance.now() - t0) / 1000;
      if (t >= total) { this.t = total; this.stopPlay(); return; }
      this.t = t;
      const ph = this.tl.querySelector<HTMLElement>('.playhead');
      if (ph) ph.style.left = `${(t / this.span()) * 100}%`;
      void this.drawStage(t);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.onPlayChange?.(true);
  }
  private stopPlay() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.fitted = false;
    this.onPlayChange?.(false);
    this.render();
  }
  get isPlaying() { return this.playing; }
  onPlayChange?: (playing: boolean) => void;

  // --- messages and keys ---------------------------------------------------------------------
  say(text: string) {
    clearTimeout(this.toastTimer);
    this.toastEl.replaceChildren(h('span', {}, text));
    const was = this.toastEl.hidden;
    this.toastEl.hidden = false;
    if (was) enter(this.toastEl, 'translate(-50%, 8px)', 200);
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, 6000);
  }
  private bindKeys() {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as Element;
      if (t.matches('input, textarea, select')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.restore(this.redoStack, this.undoStack); else this.restore(this.undoStack, this.redoStack); return; }
      if (mod || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); this.play(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.removeSelected(); return; }
      const s = this.sel;
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && s?.kind === 'pose') {
        e.preventDefault();
        const lane = this.laneOf(s.cast), i = Math.max(0, Math.min(lane.poses.length - 1, s.i + (e.key === 'ArrowRight' ? 1 : -1)));
        this.sel = { kind: 'pose', cast: s.cast, i };
        this.t = laneTimes(lane)[i].start;
        this.render();
      }
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  private disposed = false;
  dispose() {
    this.disposed = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    for (const u of this.photoUrls.values()) URL.revokeObjectURL(u);
    clearTimeout(this.toastTimer);
    void this.stageReady?.then(() => this.stage.destroy());
  }
}

function svgCurve(d: string): SVGSVGElement {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 40 24'); s.setAttribute('width', '40'); s.setAttribute('height', '24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6');
  s.append(p);
  return s;
}
