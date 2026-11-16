// Act it out: a panel built from you. Choose photos (or take one with the webcam); the app finds your body
// and draws dots on it; drag any that are off; the character copies the pose, in the angle you stand at.
// Poses run left to right along the bottom; Play moves from one to the next.
import { bodyShown, DOTS, BONES, inPicture, poseFromPoints, standingPoints } from '../capture/act';
import type { Landmark } from '../capture/mapping';
import { detectPose } from '../capture/tracker';
import { placeActor } from '../model/actor';
import { actedFrames, compileActed, DEFAULT_HOLD, DEFAULT_MOVE, momentAt, momentFrames, type Acted, type ActedPose, type Moment } from '../model/act';
import { mirrorAngles } from '../model/pads';
import { cameraRect, FPS, formatById, newShot, uid } from '../model/shot';
import { VIEWS, VIEW_LABEL, type ViewId } from '../model/skeleton';
import type { Panel } from '../model/storyboard';
import type { SavedPose } from '../model/types';
import type { Project } from '../project/project';
import { StageView } from '../render/stage';
import { finishedFrame, pictures, prepareStage } from '../render/thumb';
import { h } from './dom';
import { EASE_OUT, enter } from './motion';

export interface ActContext {
  project: Project;
  panel: Panel;
  /** Its number on the storyboard, from 1. */
  number: number;
  onChanged: () => void;
  back: () => void;
  /** Open the Characters screen (to import or set joints). */
  characters: () => void;
}

const fmt = (s: number) => `${(Math.round(s * 10) / 10).toFixed(1)}s`;

export class ActView {
  private p: Panel;
  private cur = 0;
  /** The character the next photo drives. */
  private who: string | null = null;
  private stage = new StageView();
  private loaded = new Set<string>();
  private stageReady: Promise<void> | null = null;
  private playing = false;
  private raf = 0;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private photoUrls = new Map<string, string>();
  private busy = '';
  private disposers: (() => void)[] = [];

  private root = h('div', { class: 'act' });
  private top = h('header', { class: 'act-top' });
  private main = h('main', { class: 'act-main' });
  private strip = h('footer', { class: 'act-strip' });
  private stageHost = h('div', { class: 'act-stage' });
  private photoBox = h('div', { class: 'act-photo' });
  private toastEl = h('div', { class: 'toast', role: 'status', hidden: true });
  private toastTimer = 0;

  constructor(host: HTMLElement, private ctx: ActContext) {
    this.p = ctx.panel;
    this.p.cast ??= [];
    this.p.moments ??= [];
    this.who = this.p.cast[0]?.id ?? null;
    this.root.append(this.top, this.main, this.strip, this.toastEl);
    host.replaceChildren(this.root);
    this.bindKeys();
    this.render();
  }

  private get acted(): Acted { return { cast: this.p.cast!, moments: this.p.moments!, background: this.p.background }; }
  private get moments() { return this.p.moments!; }
  private shot() { return compileActed(`panel:${this.p.id}`, this.acted); }
  private rigOf(castId: string | null) {
    const c = this.p.cast!.find((x) => x.id === castId);
    return c ? this.ctx.project.characters.find((e) => e.name === c.character)?.data.rig ?? null : null;
  }
  private moment(): Moment | null { return this.moments[this.cur] ?? null; }

  // --- undo ---------------------------------------------------------------------------
  private snapshot() { return JSON.stringify({ cast: this.p.cast, moments: this.p.moments, background: this.p.background, cur: this.cur, who: this.who }); }
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
    Object.assign(this.p, { cast: v.cast, moments: v.moments, background: v.background });
    if (!v.background) delete this.p.background;
    this.cur = Math.min(v.cur, Math.max(0, this.moments.length - 1));
    this.who = v.who;
    this.ctx.onChanged();
    this.render();
  }

  // --- the cast -------------------------------------------------------------------------
  /** Put a character into the panel, standing where the frame can see it. */
  private castCharacter(name: string): string | null {
    const entry = this.ctx.project.characters.find((c) => c.name === name);
    if (!entry) return null;
    const temp = newShot('cast');
    temp.actors = this.p.cast!.map((c) => ({ id: c.id, character: c.character, role: 'actor' as const, base: { view: 'front' as const, flip: false, rootAngle: 0, angles: {}, root: c.root, scale: c.scale }, keys: [], mouth: [] }));
    const placed = placeActor(temp, name, entry.data.rig);
    if (!placed) return null;
    const id = uid();
    this.p.cast!.push({ id, character: name, root: placed.base.root, scale: placed.base.scale ?? 1 });
    return id;
  }

  // --- photos -------------------------------------------------------------------------
  private photoUrl(file: string): string | null {
    const have = this.photoUrls.get(file);
    if (have) return have;
    const bytes = this.ctx.project.assets.get(`photos/${file}`);
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    this.photoUrls.set(file, url);
    return url;
  }
  private freeName(name: string) {
    const clean = name.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_') || 'photo.jpg';
    const dot = clean.lastIndexOf('.'), stem = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '.jpg';
    let out = clean;
    for (let i = 2; this.ctx.project.assets.has(`photos/${out}`); i++) out = `${stem}-${i}${ext}`;
    return out;
  }

  /** Each photo becomes the next pose, in order. */
  async addPhotos(files: { name: string; bytes: Uint8Array }[], mirror = false) {
    if (!files.length) return;
    if (!this.who) { this.say('Choose who you are playing first.'); return; }
    const rig = this.rigOf(this.who);
    if (!rig) return;
    this.busy = files.length > 1 ? `Finding you in ${files.length} photos…` : 'Finding you in the photo…';
    this.render();
    const made: Moment[] = [];
    let lost = 0;
    let prev = this.moment()?.poses[this.who] ?? null;
    for (const f of files) {
      const url = URL.createObjectURL(new Blob([f.bytes as unknown as BlobPart]));
      try {
        const img = new Image();
        await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('not an image')); img.src = url; });
        const w = img.naturalWidth, hgt = img.naturalHeight;
        let points: Landmark[] | null = null;
        try { points = await detectPose(img, w, hgt); } catch { points = null; }
        if (!points) { lost++; points = standingPoints(w, hgt); }
        const file = this.freeName(f.name);
        this.ctx.project.assets.set(`photos/${file}`, f.bytes);
        const pose = poseFromPoints(points, rig, { mirror, size: { w, h: hgt }, current: prev ?? undefined });
        prev = pose;
        made.push({ id: uid(), hold: DEFAULT_HOLD, move: DEFAULT_MOVE, photo: file, size: { w, h: hgt }, points, mirror, actor: this.who, poses: { [this.who]: pose } });
      } catch {
        lost++;
      } finally { URL.revokeObjectURL(url); }
    }
    this.busy = '';
    if (!made.length) { this.render(); this.say('Those files could not be read as photos.'); return; }
    this.change(() => {
      const at = this.moments.length ? this.cur + 1 : 0;
      this.moments.splice(at, 0, ...made);
      this.cur = at + made.length - 1;
    });
    if (lost) this.say(lost === made.length && lost === 1
      ? 'No person found in that photo. Drag the dots onto the body yourself.'
      : `${lost} of ${made.length} photos had no person the app could find. Drag their dots into place.`);
  }

  private choosePhotos(mirror = false) {
    const input = h('input', {
      type: 'file', accept: 'image/*', multiple: true,
      onchange: async () => {
        const files = await Promise.all([...(input.files ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
          .map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
        await this.addPhotos(files, mirror);
      },
    });
    input.click();
  }

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
      if (blob) await this.addPhotos([{ name: `webcam_${this.moments.length + 1}.jpg`, bytes: new Uint8Array(await blob.arrayBuffer()) }], false);
    });
  }

  // --- changing a pose ------------------------------------------------------------------------
  /** Read the current photo again (after a dot moved, or a choice changed). */
  private reapply(m: Moment) {
    const castId = m.actor ?? this.who;
    const rig = this.rigOf(castId);
    if (!rig || !m.points || !castId) return;
    const old = m.poses[castId];
    const keep = (m as Moment & { keep?: { view?: ViewId; flip?: boolean } }).keep ?? {};
    m.poses[castId] = poseFromPoints(m.points, rig, { mirror: m.mirror, size: m.size, view: keep.view, flip: keep.flip, current: old });
  }
  private setKeep(m: Moment, k: { view?: ViewId; flip?: boolean }) {
    const mm = m as Moment & { keep?: { view?: ViewId; flip?: boolean } };
    mm.keep = { ...mm.keep, ...k };
    this.reapply(m);
  }

  private savePose() {
    const m = this.moment(), castId = m?.actor ?? this.who, pose = castId ? m?.poses[castId] : null;
    if (!m || !pose) return;
    const name = `Pose ${this.ctx.project.poses.length + 1}`;
    const saved: SavedPose = { name, tags: [], view: pose.view, flip: pose.flip, rootAngle: pose.rootAngle, angles: { ...pose.angles }, swaps: pose.swaps };
    const shot = this.shot();
    void pictures.picture(this.ctx.project, shot, 160, momentFrames(this.moments)[this.cur].start).then((url) => { saved.thumb = url; this.ctx.onChanged(); });
    this.ctx.project.poses.push(saved);
    this.ctx.onChanged();
    this.say(`Saved as "${name}". Use it from My poses in any panel.`);
  }
  private applySaved(sp: SavedPose, mirror: boolean) {
    const castId = this.who;
    const rig = this.rigOf(castId);
    if (!castId || !rig) return;
    this.change(() => {
      const pose: ActedPose = { view: rig.views[sp.view] ? sp.view : (VIEWS.find((v) => rig.views[v]) ?? 'front'), flip: sp.flip, rootAngle: mirror ? -sp.rootAngle : sp.rootAngle, angles: mirror ? mirrorAngles(sp.angles) : { ...sp.angles }, swaps: sp.swaps };
      if (!this.moments.length) { this.moments.push({ id: uid(), hold: DEFAULT_HOLD, move: DEFAULT_MOVE, actor: castId, poses: { [castId]: pose } }); this.cur = 0; }
      else this.moments[this.cur].poses[castId] = pose;
    });
  }

  private chooseBackground() {
    const input = h('input', {
      type: 'file', accept: 'image/*',
      onchange: async () => {
        const f = input.files?.[0];
        if (!f) return;
        const bytes = new Uint8Array(await f.arrayBuffer()), name = f.name.replace(/[^\w.\- ]+/g, '_');
        const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
        const img = new Image();
        try { await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(); img.src = url; }); } catch { this.say(`${f.name} is not an image the browser can show.`); return; } finally { URL.revokeObjectURL(url); }
        this.ctx.project.assets.set(`backgrounds/${name}`, bytes);
        // Cover the stage, centred.
        const st = newShot('x').stage, scale = Math.max(st.w / img.naturalWidth, st.h / img.naturalHeight);
        this.change(() => { this.p.background = { file: name, scale, x: (st.w - img.naturalWidth * scale) / 2, y: (st.h - img.naturalHeight * scale) / 2 }; });
      },
    });
    input.click();
  }

  // --- drawing -------------------------------------------------------------------------
  render() {
    this.renderTop();
    this.renderMain();
    this.renderStrip();
  }

  private renderTop() {
    const { panel } = this.ctx;
    const line = panel.notes.split('\n')[0];
    this.top.replaceChildren(
      h('button', { id: 'act-back', onclick: () => this.ctx.back() }, '← Storyboard'),
      h('strong', { class: 'act-title' }, `Panel ${this.ctx.number}`),
      line ? h('span', { class: 'muted act-line' }, line) : h('span', {}),
      h('span', { class: 'grow' }),
      h('button', { id: 'act-background', onclick: () => this.chooseBackground() }, this.p.background ? 'Change background…' : 'Background…'),
      h('button', { id: 'act-play', class: 'dark', disabled: this.moments.length < 2, onclick: () => this.play() }, this.playing ? '■ Stop' : '▶ Play'),
    );
  }

  private renderMain() {
    const chars = this.ctx.project.characters;
    if (this.busy) { this.main.replaceChildren(h('div', { class: 'act-card' }, h('p', { class: 'act-busy', role: 'status' }, this.busy))); return; }
    if (!chars.length) {
      this.main.replaceChildren(h('div', { class: 'act-card' },
        h('h1', {}, 'First, a character'),
        h('p', { class: 'muted' }, 'Import a character and set its joints. Then come back and act out this panel.'),
        h('button', { class: 'primary big', id: 'act-to-characters', onclick: () => this.ctx.characters() }, 'Go to Characters')));
      return;
    }
    if (!this.moments.length) {
      // Who are you playing? Picked before the first photo, so the app knows whose drawings to use.
      if (!this.who && chars.length === 1) this.change(() => { this.who = this.castCharacter(chars[0].name); });
      const castNames = new Set(this.p.cast!.map((c) => c.character));
      this.main.replaceChildren(h('div', { class: 'act-card' },
        h('h1', {}, 'Act it out'),
        h('p', { class: 'muted' }, 'Do the pose yourself. The app finds your body, and your character copies it.'),
        chars.length > 1 ? h('div', { class: 'act-who' }, h('span', { class: 'muted' }, 'You are playing'),
          chars.map((c) => h('button', {
            class: this.p.cast!.find((x) => x.id === this.who)?.character === c.name ? 'dark' : '', 'data-who': c.name,
            onclick: () => this.change(() => { const have = this.p.cast!.find((x) => x.character === c.name); this.who = have?.id ?? this.castCharacter(c.name); }),
          }, c.name, castNames.has(c.name) ? '' : ''))) : null,
        h('div', { class: 'act-choices' },
          h('button', { class: 'primary big', id: 'act-webcam', disabled: !this.who, onclick: () => void this.webcamPhoto() }, 'Use the webcam'),
          h('button', { class: 'big', id: 'act-photos', disabled: !this.who, onclick: () => this.choosePhotos() }, 'Choose photos…')),
        h('div', { class: 'act-steps' },
          h('span', {}, h('b', {}, '1 · Act'), 'a photo, or several in order'),
          h('span', {}, h('b', {}, '2 · Check the dots'), 'drag any that are off'),
          h('span', {}, h('b', {}, '3 · Your character'), 'copies you, in the same angle'))));
      return;
    }
    // A take: the photo with its dots on the left, the character on the right.
    const m = this.moment()!, castId = m.actor ?? this.who, pose = castId ? m.poses[castId] : undefined, rig = this.rigOf(castId);
    const charName = this.p.cast!.find((c) => c.id === castId)?.character ?? '';
    const views = rig ? VIEWS.filter((v) => rig.views[v]) : [];
    const poses = this.ctx.project.poses;
    const left = h('section', { class: 'act-pane', 'aria-label': 'Your take' },
      h('div', { class: 'act-label' }, h('b', {}, 'Your take'), h('span', { class: 'muted' }, ` · pose ${this.cur + 1} of ${this.moments.length}`),
        m.points && bodyShown(m.points, m.size) === 'half' ? h('span', { class: 'pill', id: 'act-half', title: 'Parts outside the photo keep the pose they had' }, 'From the waist up: the legs keep their pose') : null,
        h('span', { class: 'grow' }), m.points ? h('span', { class: 'hint' }, 'Drag a dot the app got wrong') : null),
      this.photoBox,
      h('div', { class: 'act-bar' },
        h('button', { id: 'act-more-photos', onclick: () => this.choosePhotos() }, '+ Photos…'),
        h('button', { id: 'act-more-webcam', onclick: () => void this.webcamPhoto() }, '+ Webcam photo'),
        m.photo ? h('button', { id: 'act-retake', onclick: () => this.retake() }, 'Replace this photo…') : null));
    const right = h('section', { class: 'act-pane', 'aria-label': `${charName} copies it` },
      h('div', { class: 'act-label' }, h('b', {}, `${charName} copies it`),
        pose ? h('span', { class: 'pill' }, `${VIEW_LABEL[pose.view]}${pose.flip ? ', flipped' : ''}`) : null,
        h('span', { class: 'grow' }),
        this.p.cast!.length > 1 || this.ctx.project.characters.length > 1 ? h('label', { class: 'act-who-select' }, h('span', { class: 'muted' }, 'Next photo plays'),
          h('select', { id: 'act-who', onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            this.change(() => { this.who = v.startsWith('+') ? this.castCharacter(v.slice(1)) : v; });
          } },
            this.p.cast!.map((c) => h('option', { value: c.id, selected: c.id === this.who }, c.character)),
            this.ctx.project.characters.filter((c) => !this.p.cast!.some((x) => x.character === c.name)).map((c) => h('option', { value: `+${c.name}` }, `Add ${c.name}`)))) : null),
      this.stageHost,
      h('div', { class: 'act-bar' },
        views.length > 1 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Angle' }, views.map((v) => h('button', {
          class: pose?.view === v ? 'selected' : '', 'data-view': v,
          onclick: () => this.change(() => { if (m.points) this.setKeep(m, { view: v }); else if (pose) pose.view = v; }),
        }, VIEW_LABEL[v]))) : null,
        h('button', { id: 'act-flip', 'aria-pressed': String(!!pose?.flip), class: pose?.flip ? 'selected' : '', onclick: () => this.change(() => { if (m.points) this.setKeep(m, { flip: !pose?.flip }); else if (pose) pose.flip = !pose.flip; }) }, 'Flip'),
        h('button', { id: 'act-save-pose', disabled: !pose, onclick: () => this.savePose() }, 'Save as a pose'),
        poses.length ? h('details', { class: 'menu up', id: 'act-my-poses' }, h('summary', {}, 'My poses'),
          h('div', { class: 'menu-items' }, poses.map((sp) => h('button', { class: 'pose-row', onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); this.applySaved(sp, false); } },
            sp.thumb ? h('img', { src: sp.thumb, alt: '' }) : h('span', { class: 'no-thumb' }), sp.name)))) : null));
    this.main.replaceChildren(left, right);
    this.renderPhoto();
    void this.drawStage();
  }

  /** The photo with the body the app found: dots you can drag, joined by lines. */
  private renderPhoto() {
    const m = this.moment();
    this.photoBox.replaceChildren();
    if (!m) return;
    if (!m.photo || !m.points || !m.size) {
      this.photoBox.append(h('p', { class: 'muted act-nophoto' }, 'This pose came from My poses, not a photo.'));
      return;
    }
    const url = this.photoUrl(m.photo);
    const img = h('img', { src: url ?? '', alt: `Photo for pose ${this.cur + 1}`, draggable: false });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'act-bones');
    svg.setAttribute('viewBox', `0 0 ${m.size.w} ${m.size.h}`);
    svg.setAttribute('aria-hidden', 'true');
    const frame = h('div', { class: 'act-photo-frame', style: `aspect-ratio:${m.size.w}/${m.size.h}` }, img, svg);
    // Only what is in the picture: the tracker's guesses for parts outside it are not shown.
    const seen = () => inPicture(m.points!, m.size);
    const drawBones = () => {
      const s2 = seen();
      svg.replaceChildren(...BONES.filter(([a, b]) => s2[a].visibility > 0.3 && s2[b].visibility > 0.3).map(([a, b]) => {
        const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l.setAttribute('x1', String(m.points![a].x)); l.setAttribute('y1', String(m.points![a].y));
        l.setAttribute('x2', String(m.points![b].x)); l.setAttribute('y2', String(m.points![b].y));
        return l;
      }));
    };
    drawBones();
    const inside = seen();
    for (const d of DOTS) {
      const pt = m.points[d.i];
      if (!pt || inside[d.i].visibility === 0) continue;
      const dot = h('button', {
        class: 'act-dot' + (pt.visibility < 0.5 ? ' unsure' : '') + ((pt as Landmark & { moved?: boolean }).moved ? ' moved' : ''),
        'aria-label': `${d.name}${pt.visibility < 0.5 ? ' (not sure)' : ''}`, 'data-dot': d.i,
        style: `left:${(pt.x / m.size.w) * 100}%;top:${(pt.y / m.size.h) * 100}%`,
      });
      let before = '';
      dot.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        dot.setPointerCapture(e.pointerId);
        before = this.snapshot();
        dot.classList.add('dragging');
      });
      dot.addEventListener('pointermove', (e) => {
        if (!dot.hasPointerCapture(e.pointerId)) return;
        const r = frame.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
        Object.assign(m.points![d.i], { x: x * m.size!.w, y: y * m.size!.h, visibility: 1, moved: true });
        dot.style.left = `${x * 100}%`; dot.style.top = `${y * 100}%`;
        drawBones();
        this.reapply(m);
        void this.drawStage();
      });
      const end = (e: PointerEvent) => {
        if (!dot.hasPointerCapture(e.pointerId)) return;
        dot.releasePointerCapture(e.pointerId);
        dot.classList.remove('dragging');
        if (before && before !== this.snapshot()) { this.undoStack.push(before); this.redoStack = []; this.ctx.onChanged(); this.renderStrip(); this.renderTop(); }
        before = '';
      };
      dot.addEventListener('pointerup', end);
      dot.addEventListener('pointercancel', end);
      frame.append(dot);
    }
    this.photoBox.append(frame);
  }

  private retake() {
    const input = h('input', {
      type: 'file', accept: 'image/*',
      onchange: async () => {
        const f = input.files?.[0];
        if (!f) return;
        const keep = this.cur;
        const before = this.moments.length;
        await this.addPhotos([{ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }], false);
        if (this.moments.length === before + 1) {
          // The new photo went in after this one: swap it in, keeping this pose's timing.
          const fresh = this.moments.splice(keep + 1, 1)[0], old = this.moments[keep];
          fresh.hold = old.hold; fresh.move = old.move;
          this.moments[keep] = fresh;
          this.cur = keep;
          this.ctx.onChanged();
          this.render();
        }
      },
    });
    input.click();
  }

  /** The character, posed as in the selected pose (or moving, while playing). */
  private async drawStage(frame?: number) {
    if (!this.stageReady) {
      this.stageReady = this.stage.init(this.stageHost);
      const ready = this.stageReady;
      const obs = new ResizeObserver(() => void ready.then(() => requestAnimationFrame(() => { if (!this.disposed) { this.stage.app.resize(); void this.drawStage(); } })));
      obs.observe(this.stageHost);
      this.disposers.push(() => obs.disconnect());
    }
    await this.stageReady;
    if (this.disposed) return;
    if (!this.stageHost.contains(this.stage.canvas)) this.stageHost.append(this.stage.canvas);
    const shot = this.shot();
    await prepareStage(this.stage, this.ctx.project, shot, this.loaded);
    if (this.disposed) return; // left the screen while images were loading
    const format = formatById('yt'), camera = shot.cameras.yt;
    const f = frame ?? (this.moments.length ? momentFrames(this.moments)[this.cur].start : 0);
    this.stage.fit(cameraRect(camera, format), 1);
    this.stage.draw(finishedFrame(this.ctx.project, shot, Math.min(shot.length - 1, f)), { format, camera });
    this.stage.clearOverlay();
  }

  private renderStrip() {
    if (!this.moments.length) { this.strip.replaceChildren(); this.strip.hidden = true; return; }
    this.strip.hidden = false;
    const shot = this.shot(), times = momentFrames(this.moments);
    const cards: Node[] = [];
    this.moments.forEach((m, i) => {
      const img = h('img', { alt: '' });
      const cached = pictures.cached(shot, times[i].start);
      if (cached) img.src = cached; else void pictures.picture(this.ctx.project, shot, 200, times[i].start).then((u) => { img.src = u; });
      const sel = i === this.cur;
      const num = (label: string, value: number, set: (n: number) => void, id: string) => h('label', { class: 'act-num' }, h('span', {}, label), h('input', {
        type: 'number', id, min: 0, max: 20, step: 0.1, value: Math.round(value * 10) / 10,
        onchange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) this.change(() => set(Math.max(0, Math.min(20, n)))); },
      }));
      cards.push(h('div', { class: 'act-pose' + (sel ? ' sel' : ''), 'data-pose': i },
        h('button', { class: 'act-pose-pick', 'aria-label': `Pose ${i + 1}`, 'aria-current': sel ? 'true' : undefined, onclick: () => { if (this.playing) this.stopPlay(); this.cur = i; this.render(); } },
          h('span', { class: 'act-pose-pic' }, img),
          h('span', { class: 'act-pose-row' }, h('b', {}, `Pose ${i + 1}`), h('span', { class: 'muted' }, `holds ${fmt(m.hold)}`))),
        sel ? h('div', { class: 'act-pose-edit' },
          num('Hold', m.hold, (n) => { m.hold = n; }, 'act-hold'),
          h('button', { class: 'link', id: 'act-remove', onclick: () => this.change(() => { this.moments.splice(i, 1); this.cur = Math.max(0, Math.min(this.cur, this.moments.length - 1)); }) }, 'Remove')) : null));
      if (i < this.moments.length - 1) {
        cards.push(sel
          ? h('label', { class: 'act-move sel' }, h('span', {}, '→'), h('input', { type: 'number', id: 'act-move', min: 0.1, max: 10, step: 0.1, value: Math.round(m.move * 10) / 10, 'aria-label': `Seconds from pose ${i + 1} to pose ${i + 2}`,
            onchange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) this.change(() => { m.move = Math.max(0.1, Math.min(10, n)); }); } }), h('span', { class: 'muted' }, 's'))
          : h('span', { class: 'act-move', title: `${fmt(m.move)} from pose ${i + 1} to pose ${i + 2}` }, h('span', {}, '→'), h('span', { class: 'muted' }, fmt(m.move))));
      }
    });
    this.strip.replaceChildren(
      h('div', { class: 'act-poses', role: 'list' }, ...cards,
        h('button', { class: 'act-next', id: 'act-next', onclick: () => this.choosePhotos() }, '+ Act the', h('br', {}), 'next pose')),
      h('span', { class: 'act-total muted' }, `${fmt(actedFrames(this.moments) / FPS)} in all`));
    this.strip.querySelector('.act-pose.sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // --- playing ------------------------------------------------------------------------
  private play() {
    if (this.playing) { this.stopPlay(); return; }
    if (this.moments.length < 2) return;
    this.playing = true;
    this.renderTop();
    const shot = this.shot(), t0 = performance.now();
    const tick = () => {
      if (!this.playing) return;
      const f = Math.floor(((performance.now() - t0) / 1000) * FPS);
      if (f >= shot.length) { this.stopPlay(); return; }
      void this.drawStage(f);
      const i = momentAt(this.moments, f);
      this.strip.querySelectorAll('.act-pose').forEach((el, k) => el.classList.toggle('playing', k === i));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  private stopPlay() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.strip.querySelectorAll('.act-pose.playing').forEach((el) => el.classList.remove('playing'));
    this.renderTop();
    void this.drawStage();
  }

  // --- messages and keys ------------------------------------------------------------------
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
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        if (!this.moments.length) return;
        e.preventDefault();
        this.cur = Math.max(0, Math.min(this.moments.length - 1, this.cur + (e.key === 'ArrowRight' ? 1 : -1)));
        this.render();
      }
      if (e.key === 'Escape' && !document.querySelector('details[open], .cam')) this.ctx.back();
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  private disposed = false;
  dispose() {
    this.disposed = true;
    this.stopPlay();
    for (const d of this.disposers) d();
    for (const u of this.photoUrls.values()) URL.revokeObjectURL(u);
    clearTimeout(this.toastTimer);
    void this.stageReady?.then(() => this.stage.destroy());
  }
}
