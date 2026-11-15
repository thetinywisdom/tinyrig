// The editor: one stage showing a shot, a tabbed side panel, and a timeline.
// This file holds the state, drawing, undo and stage interactions; the panels
// and the timeline live in their own files and talk to this class.
import { AudioEngine } from '../audio/audio';
import {
  apply, boneMatrices, canBend, clampToLimit, defaultVariant, invert, normDeg, restPose, rootMatrix, solveLimbIK, swapOptions, swingAround,
} from '../model/pose';
import { moveKnob } from '../model/pads';
import {
  JOINTS, JOINT_BY_ID, JOINT_OF_BONE, LIMBS, ROOT_BONE, unlockedJoints, VIEWS, type BoneId, type JointId, type LimbId,
} from '../model/skeleton';
import {
  cameraRect, evaluate, formatById, FORMATS, keyAt, MAX_ACTORS, newShot, setKey, sortedKeys, syncCameras, uid, visibleLayers, visibleTexts,
  type Actor, type Shot,
} from '../model/shot';
import type { Pose, Pt, Rect, Rig, RigView, SavedPose } from '../model/types';
import type { CharacterEntry, Project } from '../project/project';
import { StageView, type DrawActor, type Marker } from '../render/stage';
import { padControl, type PadView } from './controls';
import { h } from './dom';
import { stopWebcam } from '../capture/panel';
import { renderPanel, setSwap } from './panels';
import { Timeline } from './timeline';

export type Tab = 'rig' | 'scene' | 'animate' | 'sound' | 'capture' | 'export';
export type SceneTool = 'characters' | 'backgrounds' | 'framing';
export type Selection = JointId | 'root' | null;
type Drag =
  | { type: 'pan'; last: Pt }
  | { type: 'fk'; joint: JointId; last: Pt }
  | { type: 'ik'; limb: LimbId }
  | { type: 'move'; last: Pt }
  | { type: 'rootRotate'; last: Pt }
  | { type: 'pivot'; joint: JointId }
  | { type: 'rootPivot' }
  | { type: 'tip'; limb: LimbId }
  | { type: 'place'; last: Pt }
  | { type: 'background'; id: string; last: Pt }
  | { type: 'camera'; last: Pt }
  | { type: 'cameraSize'; anchor: Pt }
  | { type: 'text'; id: string; last: Pt };

export interface EditorContext {
  project: Project;
  /** Which shot to open, and a character to drop into it straight away (just imported). */
  shotName?: string;
  addCharacter?: string;
  onChanged: () => void;
  onShot: (name: string) => void;
  importCharacter: () => void;
  download: (name: string, bytes: Uint8Array, type: string) => void;
  menu: () => { label: string; run: () => void }[];
  status: () => string;
}

/** The path through the tool, left to right. Capture is part of Animate. */
const STEPS: [Tab, string][] = [['rig', 'Character'], ['scene', 'Scene'], ['animate', 'Animate'], ['sound', 'Sound'], ['export', 'Export']];
const HINTS: Record<Tab, string> = {
  rig: 'Drag a pivot to move it. The square is the point the character turns around.',
  scene: 'Drag characters, image layers or the blue frame, whichever is chosen above.',
  animate: 'Drag any part of the character to pose it. K sets a keyframe, Space plays.',
  sound: 'New sound and text start at the playhead. Drag them on the timeline to move them.',
  capture: 'Load a photo of a pose, or use the webcam, to pose the selected character.',
  export: 'Each output shape uses its own framing from the Scene step.',
};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class Editor {
  project: Project;
  shot!: Shot;
  frame = 0;
  tab: Tab = 'animate';
  sceneTool: SceneTool = 'characters';
  selId: string | null = null;
  selJoint: Selection = null;
  selPad: string | null = null;
  selBg: string | null = null;
  selText: string | null = null;
  formatId = 'yt';
  showFrame = true;
  /** The side panel holds everything beyond the basics. It starts closed so the stage has the window. */
  panelOpen = false;
  /** Which "More" groups are open in the panel. */
  open = new Set<string>();
  /** Opens every "More" group: used by the checks in /scripts. */
  openAll = false;
  /** Pose thumbnails, kept out of undo snapshots because they are large and never change. */
  private thumbs = new Map<string, string>();
  onion = false;
  autoKey = false;
  playing = false;
  /** The pose each character is shown in: the timeline's, or an edit not yet keyed. */
  poses = new Map<string, Pose>();
  unsaved = new Set<string>();
  poseFilter = '';
  /** A photo shown faintly on the stage while capturing a pose from it. */
  stage = new StageView();
  audio = new AudioEngine();
  timeline!: Timeline;

  private drag: Drag | null = null;
  private spaceDown = false;
  private padViews = new Map<string, PadView>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private saved = '';
  private playTimer = 0;
  private disposers: (() => void)[] = [];

  private toolbar = h('header', { class: 'toolbar' });
  panel = h('aside', { class: 'panel' });
  private stageHost = h('div', { class: 'stage' });
  private padLayer = h('div', { class: 'pad-layer' });
  private body = h('div', { class: 'body' });
  /** The main action of the current step, top left of the stage. */
  private actionBar = h('div', { class: 'action-bar' });
  /** The few controls changed all the time, next to the selected character. */
  private charBar = h('div', { class: 'char-bar', hidden: true });
  private emptyNote = h('div', { class: 'empty-note', hidden: true });
  private timelineHost = h('div', { class: 'timeline' });
  private hint = h('footer', { class: 'hint' });

  private constructor(private host: HTMLElement, public ctx: EditorContext) {
    this.project = ctx.project;
  }

  static async mount(host: HTMLElement, ctx: EditorContext): Promise<Editor> {
    const ed = new Editor(host, ctx);
    await ed.init();
    return ed;
  }

  private async init() {
    const { project, ctx } = this;
    this.body.replaceChildren(h('div', { class: 'work' }, this.stageHost, this.timelineHost), this.panel);
    this.host.replaceChildren(h('div', { class: 'editor' }, this.toolbar, this.body, this.hint));
    this.layout();
    await this.stage.init(this.stageHost);
    this.stageHost.append(this.padLayer, this.emptyNote, this.charBar, this.actionBar,
      h('button', { class: 'fit', title: 'Fit the frame in the window', onclick: () => { this.fitView(); this.redraw(); } }, 'Fit'));
    for (const c of project.characters) this.stage.setCharacter(c.name, c.data.imp);

    if (!project.shots.length) project.shots.push(newShot('Shot 1'));
    this.shot = project.shots.find((s) => s.name === ctx.shotName) ?? project.shots[0];
    // A project made before shots existed: put its characters on the stage.
    if (!this.shot.actors.length && !ctx.addCharacter) for (const c of project.characters.slice(0, MAX_ACTORS)) this.addActor(c.name, false);
    if (ctx.addCharacter) this.addActor(ctx.addCharacter, false);
    this.selId = this.shot.actors.find((a) => a.character === ctx.addCharacter)?.id ?? this.shot.actors[0]?.id ?? null;

    await this.loadAssets();
    this.timeline = new Timeline(this, this.timelineHost);
    this.bindStage();
    this.evaluateAll();
    this.saved = this.snapshot();
    requestAnimationFrame(() => { this.fitView(); this.refresh(); });
  }

  /** Background images, sounds and fonts the shot uses. Missing or unreadable files are skipped. */
  async loadAssets() {
    const { project } = this;
    for (const bg of this.shot.backgrounds) {
      const bytes = project.assets.get(`backgrounds/${bg.file}`);
      if (bytes) await this.stage.setBackground(bg.file, bytes).catch(() => undefined);
    }
    for (const clip of this.shot.audio) {
      const bytes = project.assets.get(`audio/${clip.file}`);
      if (bytes) await this.audio.load(clip.file, bytes).catch(() => undefined);
    }
    for (const [path, bytes] of project.assets) if (path.startsWith('fonts/')) await this.loadFontFile(path.slice(6), bytes).catch(() => undefined);
    for (const family of project.googleFonts) this.loadGoogleFont(family);
  }
  async loadFontFile(file: string, bytes: Uint8Array): Promise<string> {
    const family = file.replace(/\.[^.]+$/, '');
    const face = new FontFace(family, bytes.slice().buffer as ArrayBuffer);
    await face.load();
    document.fonts.add(face);
    return family;
  }
  /** Fetches a font from Google Fonts. The one place the app goes online, and only when a Google font is added. */
  loadGoogleFont(family: string) {
    const id = `gf-${family.replace(/\W+/g, '-')}`;
    if (!document.getElementById(id)) {
      document.head.appendChild(h('link', { id, rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@400;700&display=swap` }));
    }
    void document.fonts.load(`700 40px "${family}"`).then(() => this.redraw()).catch(() => undefined);
  }

  // --- lookups ---------------------------------------------------------------
  entry(actor: Actor | null): CharacterEntry | undefined { return this.project.characters.find((c) => c.name === actor?.character); }
  sel(): Actor | null { return this.shot.actors.find((a) => a.id === this.selId) ?? null; }
  rig(actor = this.sel()): Rig | null { return this.entry(actor)?.data.rig ?? null; }
  pose(actor = this.sel()): Pose | null { return actor ? this.poses.get(actor.id) ?? null : null; }
  view(actor = this.sel()): RigView | null {
    const rig = this.rig(actor), pose = this.pose(actor);
    return (rig && pose && rig.views[pose.view]) || null;
  }
  unlocked(actor = this.sel()): Set<JointId> { return unlockedJoints(this.rig(actor)?.level ?? 'high'); }
  format() { return formatById(this.formatId); }
  camera() { return this.shot.cameras[this.formatId]; }
  /** What is drawn for an actor: in the Rig tab the selected one stands in its rest pose. */
  private shownPose(actor: Actor): Pose | null {
    const pose = this.pose(actor), rig = this.rig(actor);
    if (!pose || !rig?.views[pose.view]) return null;
    if (this.tab === 'rig' && actor.id === this.selId) return { ...restPose(rig.views[pose.view]!, pose.view, pose.root), scale: pose.scale };
    return pose;
  }

  // --- timeline state ----------------------------------------------------------
  evaluateAll() {
    this.poses.clear();
    this.unsaved.clear();
    for (const a of this.shot.actors) {
      const rig = this.rig(a);
      const pose = evaluate(this.shot, a, this.frame);
      // A view the character no longer has (art re-imported) falls back to one it does.
      if (rig && !rig.views[pose.view]) pose.view = VIEWS.find((v) => rig.views[v]) ?? pose.view;
      this.poses.set(a.id, pose);
    }
  }

  /** Call after changing a character's working pose. Decides where the change is stored. */
  edited(actor = this.sel()) {
    const pose = this.pose(actor);
    if (!actor || !pose) return;
    if (actor.role === 'extra' || !actor.keys.length) actor.base = clone(pose); // not animated yet: this is simply its pose
    else if (this.autoKey || keyAt(actor, this.frame)) { setKey(actor, this.frame, pose); this.unsaved.delete(actor.id); }
    else this.unsaved.add(actor.id); // shown, but lost on leaving the frame unless keyed
  }

  setKeyHere(actor = this.sel()) {
    const pose = this.pose(actor);
    if (!actor || !pose || actor.role === 'extra') return;
    setKey(actor, this.frame, pose);
    this.unsaved.delete(actor.id);
    this.refresh();
  }
  deleteKeyHere(actor = this.sel()) {
    if (!actor) return;
    actor.keys = actor.keys.filter((k) => k.frame !== this.frame);
    this.evaluateAll();
    this.refresh();
  }

  setFrame(frame: number, opts: { scrub?: boolean; keep?: boolean } = {}) {
    const f = Math.min(this.shot.length - 1, Math.max(0, Math.round(frame)));
    if (f === this.frame && !opts.keep) { this.timeline.draw(); return; }
    this.frame = f;
    this.evaluateAll();
    if (opts.scrub) this.audio.scrub(this.shot, f);
    this.redraw();
    this.timeline.draw();
    if (!this.playing && !opts.scrub) { this.timeline.renderBar(); this.renderPanel(); }
  }

  play() {
    if (this.playing) return this.stop();
    this.playing = true;
    if (this.frame >= this.shot.length - 1) this.frame = 0;
    const from = this.frame, t0 = performance.now();
    this.audio.play(this.shot, from);
    const tick = () => {
      if (!this.playing) return;
      const f = from + Math.floor(((performance.now() - t0) / 1000) * 24);
      if (f >= this.shot.length) { this.playing = false; this.audio.stop(); this.setFrame(0); this.play(); return; }
      if (f !== this.frame) { this.frame = f; this.evaluateAll(); this.redraw(); this.timeline.draw(); }
      this.playTimer = requestAnimationFrame(tick);
    };
    this.playTimer = requestAnimationFrame(tick);
    this.timeline.renderBar();
  }
  stop() {
    this.playing = false;
    cancelAnimationFrame(this.playTimer);
    this.audio.stop();
    this.timeline.renderBar();
    this.renderPanel();
  }

  // --- scene -------------------------------------------------------------------
  /** Put a character on the stage, sized to sit comfortably in a 1080-tall frame. */
  addActor(character: string, refresh = true): Actor | null {
    const entry = this.project.characters.find((c) => c.name === character);
    const viewId = entry && VIEWS.find((v) => entry.data.rig.views[v]);
    if (!entry || !viewId) return null;
    const view = entry.data.rig.views[viewId]!;
    const boxes = Object.values(view.pieces).filter((p) => !p.shared).map((p) => p.bbox);
    const top = Math.min(...boxes.map((b) => b.y)), bottom = Math.max(...boxes.map((b) => b.y + b.h));
    const left = Math.min(...boxes.map((b) => b.x)), right = Math.max(...boxes.map((b) => b.x + b.w));
    const height = bottom - top, scale = height > 1000 || height < 500 ? Math.round((800 / height) * 100) / 100 : 1;
    const n = this.shot.actors.length, slot = [0, -1, 1][n % 3] * 420 + Math.floor(n / 3) * 120;
    const role = this.shot.actors.filter((a) => a.role === 'actor').length < MAX_ACTORS ? 'actor' : 'extra';
    const centre = { x: this.shot.stage.w / 2 + slot, y: this.shot.stage.h / 2 };
    const base: Pose = {
      ...restPose(view, viewId), scale,
      root: { x: centre.x + (view.rootPivot.x - (left + right) / 2) * scale, y: centre.y + (view.rootPivot.y - (top + bottom) / 2) * scale },
    };
    const actor: Actor = { id: uid(), character, role, base, keys: [], mouth: [] };
    this.shot.actors.push(actor);
    if (!this.stage.hasCharacter(character)) this.stage.setCharacter(character, entry.data.imp);
    this.selId = actor.id;
    if (refresh) { this.evaluateAll(); this.refresh(); }
    return actor;
  }

  // --- layers: images and text on the timeline ----------------------------------------
  /** Ask for image files and add each as a layer behind or in front of the characters, lasting the whole shot. */
  addImageLayer(front: boolean) {
    const input = h('input', {
      type: 'file', accept: 'image/*,.svg', multiple: true,
      onchange: async () => {
        for (const file of [...(input.files ?? [])]) {
          const name = file.name.replace(/[^\w.\- ]+/g, '_'), bytes = new Uint8Array(await file.arrayBuffer());
          try {
            await this.stage.setBackground(name, bytes);
            this.project.assets.set(`backgrounds/${name}`, bytes);
            const size = this.stage.backgroundSize(name)!, { stage } = this.shot, cam = this.camera();
            // A background covers the whole stage. An ornament starts small, in the middle of the frame.
            const scale = Math.round((front ? Math.min(1, (cam.width * 0.3) / size.w) : Math.max(stage.w / size.w, stage.h / size.h)) * 100) / 100;
            const centre = front ? { x: cam.x, y: cam.y } : { x: stage.w / 2, y: stage.h / 2 };
            const layer = { id: uid(), file: name, scale, front: front || undefined, x: centre.x - (size.w * scale) / 2, y: centre.y - (size.h * scale) / 2 };
            this.shot.backgrounds.push(layer);
            this.selBg = layer.id;
            this.selText = null;
          } catch (err) { this.say(err instanceof Error ? err.message : String(err)); }
        }
        if (this.tab === 'scene') this.sceneTool = 'backgrounds';
        this.refresh();
      },
    });
    input.click();
  }
  /** A text layer at the playhead, two seconds long, in the middle of the frame. */
  addTextLayer() {
    const cam = this.camera(), shot = this.shot;
    const end = Math.max(this.frame + 1, Math.min(shot.length, this.frame + 48));
    const item = { id: uid(), kind: 'text' as const, text: 'Text', start: this.frame, end, x: cam.x, y: cam.y - cam.width * 0.15, size: Math.round(cam.width * 0.06), color: '#1f2430' };
    shot.texts.push(item);
    this.selText = item.id;
    this.selBg = null;
    this.refresh();
  }

  fitView() {
    const r = this.showFrame ? cameraRect(this.camera(), this.format()) : { x: 0, y: 0, w: this.shot.stage.w, h: this.shot.stage.h };
    this.stage.fit(r, 0.9);
  }

  // --- undo / redo ---------------------------------------------------------------
  // Whole-state snapshots taken whenever an action finishes. One drag is one step.
  private snapshot() {
    return JSON.stringify({
      shot: this.shot, frame: this.frame, selId: this.selId, pads: this.project.pads,
      rigs: this.project.characters.map((c) => c.data.rig), poses: [...this.poses], unsaved: [...this.unsaved],
      library: this.project.poses.map(({ thumb, ...rest }) => { if (thumb) this.thumbs.set(rest.name, thumb); return rest; }),
    });
  }
  commit() {
    const now = this.snapshot();
    if (now === this.saved) return;
    this.undoStack.push(this.saved);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.saved = now;
    this.renderToolbar();
    this.ctx.onChanged();
  }
  private restore(from: string[], to: string[]) {
    if (this.drag || !from.length) return;
    to.push(this.saved);
    this.saved = from.pop()!;
    const s = JSON.parse(this.saved);
    Object.assign(this.shot, s.shot);
    this.frame = s.frame;
    this.selId = s.selId;
    this.project.pads.splice(0, this.project.pads.length, ...s.pads);
    this.project.poses.splice(0, this.project.poses.length, ...s.library.map((p: SavedPose) => ({ ...p, thumb: this.thumbs.get(p.name) })));
    this.project.characters.forEach((c, i) => { if (s.rigs[i]) Object.assign(c.data.rig, s.rigs[i]); });
    this.poses = new Map(s.poses);
    this.unsaved = new Set(s.unsaved);
    this.ctx.onChanged();
    void this.loadAssets().then(() => this.refresh());
  }
  undo = () => this.restore(this.undoStack, this.redoStack);
  redo = () => this.restore(this.redoStack, this.undoStack);

  // --- drawing ---------------------------------------------------------------
  private drawActors(): DrawActor[] {
    const out: DrawActor[] = [];
    for (const a of this.shot.actors) {
      const rig = this.rig(a), pose = this.shownPose(a);
      if (rig && pose) out.push({ id: a.id, rig, pose, unlocked: this.unlocked(a), extra: a.role === 'extra' && a.id !== this.selId });
    }
    return out;
  }

  private markers(): { list: Marker[]; ids: (Drag | null)[] } {
    const list: Marker[] = [], ids: (Drag | null)[] = [];
    const actor = this.sel(), v = this.view(), pose = actor && this.shownPose(actor);
    if (!actor || !v || !pose || (this.tab !== 'rig' && this.tab !== 'animate')) return { list, ids };
    const unlocked = this.unlocked(), mats = boneMatrices(v, pose, unlocked);
    if (this.tab === 'rig') {
      for (const j of JOINTS) {
        const pivot = v.pivots[j.id];
        if (!pivot) continue;
        list.push({ kind: 'pivot', at: apply(mats[j.parent], pivot), active: this.selJoint === j.id, locked: !unlocked.has(j.id) });
        ids.push({ type: 'pivot', joint: j.id });
      }
      for (const l of LIMBS) {
        const tip = v.tips[l.id];
        if (!tip || v.pivots[l.end]) continue; // with a wrist or ankle pivot, that pivot is the tip
        list.push({ kind: 'tip', at: apply(mats[JOINT_BY_ID[l.lower].bone], tip), active: false });
        ids.push({ type: 'tip', limb: l.id });
      }
      list.push({ kind: 'root', at: apply(mats[ROOT_BONE], v.rootPivot), active: this.selJoint === 'root' });
      ids.push({ type: 'rootPivot' });
    } else {
      if (this.selJoint && this.selJoint !== 'root' && v.pivots[this.selJoint]) {
        list.push({ kind: 'pivot', at: apply(mats[JOINT_BY_ID[this.selJoint].parent], v.pivots[this.selJoint]), active: true, locked: false });
        ids.push(null);
      }
      for (const l of this.ikLimbs()) {
        list.push({ kind: 'handle', at: apply(mats[JOINT_BY_ID[l.lower].bone], v.tips[l.id]!), active: this.drag?.type === 'ik' && this.drag.limb === l.id });
        ids.push({ type: 'ik', limb: l.id });
      }
    }
    return { list, ids };
  }
  private ikLimbs() {
    const v = this.view(), u = this.unlocked();
    return v ? LIMBS.filter((l) => v.tips[l.id] && canBend(v, u, l.upper) && canBend(v, u, l.lower)) : [];
  }

  /** Previous and next key poses of the selected character, drawn faintly. */
  private ghostPoses(actor: Actor): Pose[] {
    const keys = sortedKeys(actor);
    const before = keys.filter((k) => k.frame < this.frame).pop(), after = keys.find((k) => k.frame > this.frame);
    return [before, after].filter(Boolean).map((k) => k!.pose);
  }

  redraw() {
    if (this.disposed) return; // a late timer or finished download after the editor closed
    syncCameras(this.shot);
    const actors = this.drawActors();
    const sel = this.sel(), selDraw = actors.find((a) => a.id === this.selId);
    const guide = this.showFrame ? { format: this.format(), camera: this.camera() } : null;
    this.stage.draw({
      shot: this.shot, actors, texts: visibleTexts(this.shot, this.frame), layers: visibleLayers(this.shot, this.frame),
      ghosts: this.onion && this.tab === 'animate' && sel && selDraw ? { actor: selDraw, poses: this.ghostPoses(sel) } : undefined,
    }, guide ?? { format: this.format(), camera: this.camera() });
    let box: Rect | null = null;
    if (this.tab === 'scene' && this.sceneTool === 'characters' && sel) box = this.stage.actor({ id: sel.id, rig: this.rig(sel)! })?.bounds() ?? null;
    if (this.selBg && (this.tab !== 'scene' || this.sceneTool === 'backgrounds')) {
      const bg = this.shot.backgrounds.find((b) => b.id === this.selBg), size = bg && this.stage.backgroundSize(bg.file);
      if (bg && size) box = { x: bg.x, y: bg.y, w: size.w * bg.scale, h: size.h * bg.scale };
    }
    this.stage.drawOverlay(this.markers().list, guide && { ...guide, active: this.tab === 'scene' && this.sceneTool === 'framing' }, this.shot.stage, box);
    const pose = this.pose();
    for (const [id, pv] of this.padViews) pv.set(pose?.pads?.[id] ?? { x: 0, y: 0 });
    this.placeCharBar();
  }

  /** Keeps the character's own controls just above its head. */
  private placeCharBar() {
    const sel = this.sel(), rig = this.rig(sel);
    const b = !this.charBar.hidden && sel && rig ? this.stage.actor({ id: sel.id, rig })?.bounds() : null;
    if (!b) return;
    const top = this.stage.worldToScreen({ x: b.x + b.w / 2, y: b.y });
    const w = this.charBar.offsetWidth, max = this.stageHost.clientWidth - w - 8;
    this.charBar.style.left = `${Math.max(8, Math.min(max, top.x - w / 2))}px`;
    this.charBar.style.top = `${Math.max(56, top.y - this.charBar.offsetHeight - 14)}px`;
  }

  /** Open or close the side panel, and show the timeline only where it is used. */
  layout() {
    this.body.classList.toggle('panel-closed', !this.panelOpen);
    this.body.classList.toggle('no-timeline', this.tab === 'rig' || this.tab === 'scene' || this.tab === 'export');
  }
  togglePanel(open = !this.panelOpen) {
    this.panelOpen = open;
    this.layout();
    this.renderBars();
    this.renderPanel();
    // The stage just changed width: keep the frame centred in it.
    requestAnimationFrame(() => { this.stage.app.resize(); this.fitView(); this.redraw(); });
  }
  /** Open the panel and press one of its buttons: how the stage's main action reaches panel features. */
  private viaPanel(id: string) {
    this.panelOpen = true;
    this.layout();
    this.renderPanel();
    document.getElementById(id)?.click();
    this.renderBars();
  }

  /** The stage's own controls: the step's main action, the selected character's bar, and the empty-stage note. */
  renderBars() {
    const { project, shot } = this, tab = this.tab, actor = this.sel(), pose = this.pose(), rig = this.rig(), v = this.view();
    const more = h('button', { id: 'more', 'aria-expanded': String(this.panelOpen), onclick: () => this.togglePanel() }, this.panelOpen ? 'Hide options' : 'More options');
    const formats = () => h('select', { id: 'format', 'aria-label': 'Output shape', title: 'Output shape to frame and export', onchange: (e: Event) => { this.formatId = (e.target as HTMLSelectElement).value; this.fitView(); this.refresh(); } },
      FORMATS.map((f) => h('option', { value: f.id, selected: f.id === this.formatId }, `${f.label} · ${f.w}×${f.h}`)));
    const addCharacter = () => h('select', { id: 'bar-add-actor', class: 'primary', 'aria-label': 'Add a character', onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value;
      if (value === '+') this.ctx.importCharacter(); else if (value) this.addActor(value);
    } }, h('option', { value: '' }, 'Add a character…'), project.characters.map((c) => h('option', { value: c.name }, c.name)), h('option', { value: '+' }, 'Import a new one…'));
    const tool = (t: SceneTool, text: string) => h('button', { class: this.sceneTool === t ? 'selected' : '', 'data-bar-tool': t, onclick: () => { this.sceneTool = t; this.refresh(); } }, text);

    const bars: Record<Tab, (Node | null)[]> = {
      rig: [h('button', { class: 'primary', id: 'bar-import', onclick: () => this.ctx.importCharacter() }, 'Import a character'), more],
      scene: [addCharacter(), h('div', { class: 'seg', role: 'group', 'aria-label': 'What to drag' }, tool('characters', 'Characters'), tool('backgrounds', 'Layers'), tool('framing', 'Framing')), formats(), more],
      animate: [h('button', { id: 'bar-capture', disabled: !actor, onclick: () => { this.tab = 'capture'; this.panelOpen = true; this.refresh(); } }, 'Pose from a photo'), more],
      capture: [h('button', { class: 'primary', id: 'bar-back', onclick: () => { this.tab = 'animate'; this.refresh(); } }, 'Back to Animate')],
      sound: [h('button', { class: 'primary', id: 'bar-dialogue', onclick: () => this.viaPanel('add-dialogue') }, 'Add dialogue'), h('button', { id: 'bar-subtitle', onclick: () => this.viaPanel('add-subtitle') }, 'Add subtitle'), more],
      export: [formats(), h('button', { class: 'primary', id: 'bar-export', onclick: () => this.viaPanel('export-mp4') }, 'Export video'), more],
    };
    this.actionBar.replaceChildren(...(bars[tab].filter(Boolean) as Node[]));

    // An empty stage says what to do next.
    this.emptyNote.hidden = shot.actors.length > 0;
    if (!shot.actors.length) this.emptyNote.replaceChildren(
      h('p', {}, project.characters.length ? 'This shot has no characters yet.' : 'Start by importing a character.'),
      project.characters.length ? addCharacter() : h('button', { class: 'primary', onclick: () => this.ctx.importCharacter() }, 'Import a character'));

    // View, flip, mouth and hands live on the character, since they change all the time.
    const show = tab === 'animate' && !!actor && !!pose && !!rig && !!v;
    this.charBar.hidden = !show;
    if (!show) return;
    const changed = () => { this.edited(); this.refresh(); };
    const options = swapOptions(v!);
    const views = VIEWS.filter((x) => rig!.views[x]);
    const pick = (slot: string, text: string) => options[slot] ? h('label', {}, h('span', {}, text), h('select', { 'data-swap': slot, onchange: (e: Event) => { setSwap(this, slot, (e.target as HTMLSelectElement).value); } },
      slot === 'mouth' ? null : h('option', { value: '', selected: !pose!.swaps?.[slot] }, 'As drawn'),
      options[slot].map((o) => h('option', { value: o, selected: o === (pose!.swaps?.[slot] ?? (slot === 'mouth' ? defaultVariant(options[slot]) : '')) }, o)))) : null;
    this.charBar.replaceChildren(...([
      shot.actors.length > 1 ? h('strong', {}, actor!.character) : null,
      views.length > 1 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, views.map((x) => h('button', { class: pose!.view === x ? 'selected' : '', 'data-view': x, onclick: () => { pose!.view = x; pose!.groupOrder = undefined; this.selJoint = null; changed(); } }, x[0].toUpperCase() + x.slice(1)))) : null,
      h('button', { id: 'flip', class: pose!.flip ? 'selected' : '', 'aria-pressed': String(pose!.flip), onclick: () => { pose!.flip = !pose!.flip; changed(); } }, 'Flip'),
      pick('mouth', 'Mouth'), pick('hand_L', 'Left hand'), pick('hand_R', 'Right hand'),
    ].filter(Boolean) as Node[]));
  }

  /** Controller pads float over the stage in the Animate tab. */
  private renderPads() {
    this.padViews = new Map();
    this.padLayer.replaceChildren();
    if (this.tab !== 'animate') return;
    for (const pad of this.project.pads) {
      const pv = padControl({
        pad, selected: this.selPad === pad.id,
        onKnob: (knob) => { const pose = this.pose(); if (pose) { moveKnob(pose, pad, knob); this.redraw(); } },
        onEnd: () => { this.edited(); this.refresh(); },
        onSelect: () => {
          if (this.selPad === pad.id) return;
          this.selPad = pad.id;
          this.renderPanel();
          this.padLayer.querySelectorAll('.pad-ctl').forEach((n) => n.classList.toggle('selected', n === pv.el));
        },
        onMoved: (at) => { pad.at = at; this.commit(); },
      });
      this.padViews.set(pad.id, pv);
      this.padLayer.appendChild(pv.el);
    }
  }

  renderPanel() { renderPanel(this); }

  /** A short message in the bar at the bottom. */
  say(text: string) {
    this.hint.textContent = text;
    this.hint.classList.add('notice');
    clearTimeout(this.sayTimer);
    this.sayTimer = window.setTimeout(() => { this.hint.classList.remove('notice'); this.hint.textContent = HINTS[this.tab]; }, 6000);
  }
  private sayTimer = 0;
  /** Result of the last video export, for the checks in /scripts. */
  lastExport: { bytes: Uint8Array; video: string; audio: string | null } | null = null;

  /**
   * One finished frame of the shot at the output shape's exact size (or smaller, for a preview).
   * Leaves the stage drawn for output: redraw() afterwards to get the editor view back.
   */
  outputFrame(frame: number, burnSubtitles: boolean, scale = 1): HTMLCanvasElement {
    const actors: DrawActor[] = [];
    for (const a of this.shot.actors) {
      const rig = this.rig(a);
      const pose = frame === this.frame ? this.pose(a) : evaluate(this.shot, a, frame);
      if (rig && pose && rig.views[pose.view]) actors.push({ id: a.id, rig, pose, unlocked: this.unlocked(a), extra: a.role === 'extra' });
    }
    const texts = visibleTexts(this.shot, frame).filter((t) => t.kind === 'text' || burnSubtitles);
    this.stage.draw({ shot: this.shot, actors, texts, layers: visibleLayers(this.shot, frame) }, { format: this.format(), camera: this.camera() });
    return this.stage.renderFrame(this.format(), this.camera(), scale);
  }

  /** Commit the finished action and bring every part of the screen up to date. */
  refresh() {
    if (this.disposed) return;
    if (!this.drag) this.commit();
    this.layout();
    this.renderPads();
    this.renderBars();
    this.redraw();
    this.renderToolbar();
    this.renderPanel();
    this.timeline.render();
    if (!this.hint.classList.contains('notice')) this.hint.textContent = HINTS[this.tab];
  }

  renderToolbar() {
    const { project, ctx } = this;
    this.toolbar.replaceChildren(
      h('select', { class: 'name', id: 'shot', 'aria-label': 'Shot', onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        if (v === '+') { const s = newShot(`Shot ${project.shots.length + 1}`); project.shots.push(s); ctx.onChanged(); ctx.onShot(s.name); } else ctx.onShot(v);
      } },
        project.shots.map((s) => h('option', { value: s.name, selected: s === this.shot }, s.name)), h('option', { value: '+' }, 'New shot…')),
      h('nav', { class: 'steps', 'aria-label': 'Steps' }, STEPS.map(([t, text], i) => {
        const here = this.tab === t || (t === 'animate' && this.tab === 'capture');
        return h('button', { class: 'step' + (here ? ' selected' : ''), 'aria-current': here ? 'step' : undefined, 'data-tab': t, onclick: () => { this.tab = t; this.drag = null; this.refresh(); } },
          h('span', { class: 'n' }, String(i + 1)), text);
      })),
      h('span', { class: 'grow' }),
      h('button', { id: 'undo', title: 'Undo (Ctrl+Z)', disabled: !this.undoStack.length, onclick: this.undo }, 'Undo'),
      h('button', { id: 'redo', title: 'Redo (Ctrl+Shift+Z)', disabled: !this.redoStack.length, onclick: this.redo }, 'Redo'),
      h('details', { class: 'menu' },
        h('summary', {}, 'Project'),
        h('div', { class: 'menu-items' },
          h('p', { class: 'meta save-status' }, ctx.status()),
          ctx.menu().map((m) => h('button', { onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); m.run(); } }, m.label)))),
    );
  }

  // --- stage interactions ------------------------------------------------------
  /** The joint a piece turns around: its own, or the nearest one above it that can bend. */
  private bendableJoint(bone: BoneId): JointId | 'root' {
    const v = this.view(), u = this.unlocked();
    while (v && bone !== ROOT_BONE) {
      const j = JOINT_OF_BONE[bone];
      if (canBend(v, u, j.id)) return j.id;
      bone = j.parent;
    }
    return 'root';
  }

  private bindStage() {
    const canvas = this.stage.canvas;
    const screenPt = (e: PointerEvent | WheelEvent): Pt => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const markerAt = (screen: Pt, radius: number): Drag | null => {
      const { list, ids } = this.markers();
      let best: Drag | null = null, bestD = radius;
      list.forEach((m, i) => {
        const s = this.stage.worldToScreen(m.at), d = Math.hypot(s.x - screen.x, s.y - screen.y);
        if (ids[i] && d <= bestD) { bestD = d; best = ids[i]; }
      });
      return best;
    };
    const order = () => this.shot.actors.filter((a) => this.rig(a)).map((a) => ({ id: a.id, rig: this.rig(a)! }));
    const cameraCorner = (screen: Pt): Pt | null => {
      const r = cameraRect(this.camera(), this.format());
      const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
      for (let i = 0; i < 4; i++) {
        const s = this.stage.worldToScreen({ x: corners[i][0], y: corners[i][1] });
        if (Math.hypot(s.x - screen.x, s.y - screen.y) < 14) return { x: corners[3 - i][0], y: corners[3 - i][1] }; // the opposite corner stays put
      }
      return null;
    };
    const textAt = (world: Pt) => visibleTexts(this.shot, this.frame).filter((t) => t.kind === 'text').reverse()
      .find((t) => Math.abs(world.y - t.y) < t.size * 0.9 && Math.abs(world.x - t.x) < Math.max(t.size, t.text.length * t.size * 0.35));

    canvas.addEventListener('pointerdown', (e) => {
      const screen = screenPt(e), world = this.stage.screenToWorld(screen);
      canvas.setPointerCapture(e.pointerId);
      if (this.playing) this.stop();
      if (e.button === 1 || this.spaceDown) { this.drag = { type: 'pan', last: screen }; return; }
      if (e.button !== 0) return;
      const pan = (): Drag => ({ type: 'pan', last: screen });
      const hit = this.stage.hitActor(order(), world);

      if (this.tab === 'scene') {
        if (this.sceneTool === 'framing') {
          const anchor = cameraCorner(screen), r = cameraRect(this.camera(), this.format());
          const inside = world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h;
          this.drag = anchor ? { type: 'cameraSize', anchor } : inside ? { type: 'camera', last: world } : pan();
          if (this.drag.type !== 'pan' && this.formatId !== 'yt') this.camera().custom = true;
        } else if (this.sceneTool === 'backgrounds') {
          const id = this.stage.hitBackground(visibleLayers(this.shot, this.frame), world);
          this.selBg = id;
          this.drag = id ? { type: 'background', id, last: world } : pan();
        } else if (hit) { this.selId = hit.id; this.drag = { type: 'place', last: world }; } else this.drag = pan();
        this.refresh();
        return;
      }
      // A layer picked on the timeline can be dragged on the stage from any step, even when it lies under a character.
      const picked = this.selBg && visibleLayers(this.shot, this.frame).find((l) => l.id === this.selBg);
      if (picked && (this.tab === 'animate' || this.tab === 'sound') && this.stage.hitBackground([picked], world) && !(hit && !picked.front)) {
        this.drag = { type: 'background', id: picked.id, last: world };
        this.refresh();
        return;
      }
      if (this.tab === 'sound' || (this.tab === 'animate' && this.selText)) {
        const t = textAt(world);
        if (!t && this.tab === 'animate') this.selText = null;
        if (!t && this.tab === 'animate') { /* fall through to posing */ } else {
        if (t) { this.selText = t.id; this.drag = { type: 'text', id: t.id, last: world }; } else this.drag = pan();
        this.refresh();
        return;
        }
      }

      const marker = markerAt(screen, 12);
      if (this.tab === 'rig') {
        if (marker) {
          this.drag = marker;
          this.selJoint = marker.type === 'pivot' ? marker.joint : marker.type === 'rootPivot' ? 'root' : this.selJoint;
        } else if (hit) {
          if (hit.id !== this.selId) { this.selId = hit.id; this.selJoint = null; } else this.selJoint = this.bendableJoint(hit.bone);
        } else { this.selJoint = null; this.drag = pan(); }
        this.refresh();
        return;
      }
      if (this.tab !== 'animate') {
        if (hit) this.selId = hit.id;
        this.drag = hit ? null : pan();
        this.refresh();
        return;
      }

      // Animate: pose the character under the pointer.
      if (marker?.type === 'ik' && !(e.altKey && hit?.id === this.selId)) {
        this.drag = marker;
        this.selJoint = LIMBS.find((l) => l.id === marker.limb)!.lower;
      } else if (hit) {
        this.selBg = this.selText = null; // posing a character lets go of any layer
        if (hit.id !== this.selId) { this.selId = hit.id; this.selJoint = null; }
        const joint = this.bendableJoint(hit.bone);
        const limb = LIMBS.find((l) => JOINT_BY_ID[l.end].bone === hit.bone);
        if (joint === 'root') this.drag = e.shiftKey ? { type: 'rootRotate', last: world } : { type: 'move', last: world };
        else if (limb && !e.altKey && this.ikLimbs().includes(limb)) this.drag = { type: 'ik', limb: limb.id };
        else this.drag = { type: 'fk', joint, last: world };
        this.selJoint = this.drag.type === 'ik' ? limb!.lower : joint;
      } else { this.selJoint = null; this.drag = pan(); }
      this.refresh();
    });

    canvas.addEventListener('pointermove', (e) => {
      const drag = this.drag;
      const screen = screenPt(e), world = this.stage.screenToWorld(screen);
      if (!drag) {
        canvas.style.cursor = markerAt(screen, 12) || this.stage.hitActor(order(), world) ? 'grab' : 'default';
        return;
      }
      const actor = this.sel(), v = this.view(), pose = this.pose(), rig = this.rig();
      const by = (last: Pt) => ({ x: world.x - last.x, y: world.y - last.y });
      const toRest = () => apply(invert(rootMatrix(v!, this.shownPose(actor!)!)), world);
      switch (drag.type) {
        case 'pan':
          this.stage.panBy(screen.x - drag.last.x, screen.y - drag.last.y);
          drag.last = screen;
          break;
        case 'fk': {
          if (!v || !pose || !rig) break;
          const j = JOINT_BY_ID[drag.joint], mats = this.stage.actor({ id: actor!.id, rig })!.mats;
          const delta = swingAround(mats[j.parent], v.pivots[j.id], drag.last, world);
          pose.angles[j.id] = clampToLimit((pose.angles[j.id] ?? 0) + delta, rig.limits[j.id]);
          drag.last = world;
          break;
        }
        case 'ik': {
          if (!v || !pose || !rig) break;
          const limb = LIMBS.find((l) => l.id === drag.limb)!;
          const solved = solveLimbIK(rig, v, pose, this.unlocked(), limb, world);
          if (solved) { pose.angles[limb.upper] = solved.upper; pose.angles[limb.lower] = solved.lower; }
          break;
        }
        case 'move':
          if (pose) pose.root = { x: pose.root.x + by(drag.last).x, y: pose.root.y + by(drag.last).y };
          drag.last = world;
          break;
        case 'rootRotate': {
          if (!pose) break;
          const a = (p: Pt) => Math.atan2(p.y - pose.root.y, p.x - pose.root.x) * 180 / Math.PI;
          pose.rootAngle = normDeg(pose.rootAngle + a(world) - a(drag.last));
          drag.last = world;
          break;
        }
        case 'pivot': {
          if (!v) break;
          const p = toRest();
          v.pivots[drag.joint] = p;
          const limb = LIMBS.find((l) => l.end === drag.joint);
          if (limb) v.tips[limb.id] = { ...p };
          break;
        }
        case 'rootPivot':
          if (v && actor) { v.rootPivot = toRest(); this.shiftActor(actor, { x: world.x - this.pose()!.root.x, y: world.y - this.pose()!.root.y }); } // the art stays still
          break;
        case 'tip':
          if (v) v.tips[drag.limb] = toRest();
          break;
        case 'place':
          if (actor) this.shiftActor(actor, by(drag.last));
          drag.last = world;
          break;
        case 'background': {
          const bg = this.shot.backgrounds.find((b) => b.id === drag.id);
          if (bg) { bg.x += by(drag.last).x; bg.y += by(drag.last).y; }
          drag.last = world;
          break;
        }
        case 'camera': {
          const cam = this.camera();
          cam.x += by(drag.last).x; cam.y += by(drag.last).y;
          drag.last = world;
          break;
        }
        case 'cameraSize': {
          const f = this.format(), cam = this.camera();
          const w = Math.max(80, Math.max(Math.abs(world.x - drag.anchor.x), (Math.abs(world.y - drag.anchor.y) * f.w) / f.h));
          const hgt = (w * f.h) / f.w;
          cam.width = w;
          cam.x = drag.anchor.x + (world.x >= drag.anchor.x ? w : -w) / 2;
          cam.y = drag.anchor.y + (world.y >= drag.anchor.y ? hgt : -hgt) / 2;
          break;
        }
        case 'text': {
          const t = this.shot.texts.find((x) => x.id === drag.id);
          if (t) { t.x += by(drag.last).x; t.y += by(drag.last).y; }
          drag.last = world;
          break;
        }
      }
      this.redraw();
    });

    const endDrag = () => {
      const drag = this.drag;
      if (!drag) return;
      this.drag = null;
      if (drag.type === 'pan') return this.redraw();
      if (['fk', 'ik', 'move', 'rootRotate'].includes(drag.type)) this.edited();
      this.refresh();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.stage.zoomAt(screenPt(e), Math.exp(-e.deltaY * 0.0015));
      this.redraw();
    }, { passive: false });

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.matches('input[type="number"], input[type="text"], input[type="search"], textarea, select');
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && !typing) {
        const key = e.key.toLowerCase();
        if (key === 'z' || key === 'y') { e.preventDefault(); if (key === 'y' || e.shiftKey) this.redo(); else this.undo(); return; }
      }
      if (typing || e.ctrlKey || e.metaKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (el.matches('button, input')) el.blur();
        // Tap Space to play or stop; hold it and drag to pan.
        if (e.type === 'keydown' && !e.repeat) this.spaceDown = true;
        if (e.type === 'keyup') { this.spaceDown = false; if (!this.drag && !this.spacePanned) this.play(); this.spacePanned = false; }
        return;
      }
      if (e.type !== 'keydown') return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); this.setKeyHere(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (el.matches('[role="slider"], input')) return;
        e.preventDefault();
        this.setFrame(this.frame + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 12 : 1));
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    canvas.addEventListener('pointerdown', () => { if (this.spaceDown) this.spacePanned = true; });
    const observer = new ResizeObserver(() => requestAnimationFrame(() => { this.stage.app.resize(); this.redraw(); this.timeline.draw(); }));
    observer.observe(this.stageHost);
    this.disposers.push(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); observer.disconnect(); });
  }
  private spacePanned = false;


  /** Move a character everywhere at once: its resting pose, every key, and what is on screen. */
  shiftActor(actor: Actor, d: Pt) {
    const move = (p: Pose) => { p.root = { x: p.root.x + d.x, y: p.root.y + d.y }; };
    move(actor.base);
    actor.keys.forEach((k) => move(k.pose));
    const shown = this.pose(actor);
    if (shown) move(shown);
  }
  /** Resize a character everywhere at once. */
  scaleActor(actor: Actor, scale: number) {
    actor.base.scale = scale;
    actor.keys.forEach((k) => { k.pose.scale = scale; });
    const shown = this.pose(actor);
    if (shown) shown.scale = scale;
  }

  private disposed = false;
  dispose() {
    this.stop();
    this.disposed = true;
    stopWebcam();
    for (const d of this.disposers) d();
    this.stage.destroy();
  }
}
