// The shot editor: a filmstrip of every shot on top, the stage in the middle, an inspector on the right
// and the timeline below. This file holds the state, drawing, undo and stage interactions; the inspector,
// the timeline and the filmstrip live in their own files and talk to this class.
import { AudioEngine } from '../audio/audio';
import { stopWebcam } from '../capture/panel';
import { placeActor } from '../model/actor';
import {
  apply, boneMatrices, canBend, clampToLimit, defaultVariant, invert, normDeg, restPose, rootMatrix, solveLimbIK, swapOptions, swingAround,
} from '../model/pose';
import {
  JOINTS, JOINT_BY_ID, JOINT_OF_BONE, LIMBS, ROOT_BONE, unlockedJoints, VIEWS, type BoneId, type JointId, type LimbId,
} from '../model/skeleton';
import {
  cameraRect, evaluate, formatById, keyAt, setKey, sortedKeys, stackOrder, syncCameras, uid, visibleLayers, visibleTexts,
  type Actor, type AudioClip, type Shot,
} from '../model/shot';
import { panelStarts, shotClips, type Panel, type SceneClip } from '../model/storyboard';
import type { Pose, Pt, Rect, Rig, RigView, SavedPose } from '../model/types';
import type { CharacterEntry, Project } from '../project/project';
import { StageView, type DrawActor, type Marker } from '../render/stage';
import { finishedFrame } from '../render/thumb';
import { h } from './dom';
import { renderFilmstrip } from './filmstrip';
import { renderInspector, setSwap } from './inspector';
import { EASE_OUT, enter } from './motion';
import { Timeline } from './timeline';

/** What the inspector shows: the thing last picked on the stage, the layer list or the timeline. */
export type Focus = 'shot' | 'actor' | 'layer' | 'text' | 'camera' | 'clip' | 'export';
/** What dragging on the stage does. Pose is the normal state; the others are entered from the inspector. */
export type Mode = 'pose' | 'rig' | 'place' | 'capture';
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
  /** Frame to open at. */
  frame?: number;
  onChanged: () => void;
  /** Open a storyboard panel's shot (making one if it has none). */
  openPanel: (panel: Panel, frame?: number) => void;
  /** Back to the storyboard. */
  back: () => void;
  importCharacter: () => void;
  download: (name: string, bytes: Uint8Array, type: string) => void;
  menu: () => { label: string; run: () => void }[];
  status: () => string;
  /** Short save state for the top bar: "Saving…", "Saved ✓" or a warning. */
  saveState: () => string;
  /** Play the whole scene, every shot and sketch in turn with its sound, from a scene frame. */
  playScene: (fromSceneFrame: number) => void;
}

const HINTS: Record<Mode | 'camera', string> = {
  pose: 'Drag a character to pose it; each pose is saved on its frame. Click an image or text to move it. Space plays. Press ? for shortcuts.',
  rig: 'Drag a pivot to move it. The square is the point the character turns around. Press Done when finished.',
  place: 'Drag the character to move it in every frame at once. Press Done when finished.',
  capture: 'Load a photo of a pose, or use the webcam, to pose the selected character.',
  camera: 'Drag inside the frame to move it, or a corner to resize it. Each output shape keeps its own framing.',
};
/** Keys (shown as key caps, joined by "or"/"and") and what they do. */
const SHORTCUTS: [string[], string, string][] = [
  [['Space'], '', 'Play or stop. Hold and drag to move the view.'],
  [[',', '.'], 'and', 'One frame back or forward (arrow keys too; Shift for 12)'],
  [['[', ']'], 'and', 'Previous or next shot'],
  [['K'], '', 'Key the pose on this frame'],
  [['\\'], '', 'Timeline: this shot, or the whole scene'],
  [['Delete'], '', 'Remove the selected image, text or sound'],
  [['Esc'], '', 'Finish rig or placing; then clear the selection'],
  [['Ctrl+Z', 'Ctrl+Shift+Z'], 'and', 'Undo and redo'],
  [['Ctrl+↑'], '', 'Back to the storyboard'],
  [['Pinch', 'Ctrl+wheel'], 'or', 'Zoom the stage. Two fingers or the wheel move it.'],
  [['?'], '', 'This list'],
];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class Editor {
  project: Project;
  shot!: Shot;
  frame = 0;
  focus: Focus = 'shot';
  mode: Mode = 'pose';
  /** The current character: the one the timeline, mouth row and character bar are about. */
  selId: string | null = null;
  selJoint: Selection = null;
  selBg: string | null = null;
  selText: string | null = null;
  selClip: string | null = null;
  formatId = 'yt';
  showFrame = true;
  /** Which folded groups in the inspector are open. */
  open = new Set<string>();
  /** Opens every folded group: used by the checks in /scripts. */
  openAll = false;
  /** Pose thumbnails, kept out of undo snapshots because they are large and never change. */
  private thumbs = new Map<string, string>();
  onion = false;
  /** Auto-record poses: every change is stored as a key on its frame. On by default (owner's plan, Phase 0). */
  autoKey = true;
  playing = false;
  /** The pose each character is shown in: the timeline's, or an edit not yet keyed. */
  poses = new Map<string, Pose>();
  unsaved = new Set<string>();
  poseFilter = '';
  stage = new StageView();
  audio = new AudioEngine();
  timeline!: Timeline;

  private drag: Drag | null = null;
  /** Whether the current drag has moved anything. A click without moving only selects. */
  private dragMoved = false;
  private spaceDown = false;
  private spacePanned = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private saved = '';
  private playTimer = 0;
  private disposers: (() => void)[] = [];

  private toolbar = h('header', { class: 'toolbar' });
  panel = h('aside', { class: 'panel inspector', 'aria-label': 'Inspector' });
  private stageHost = h('div', { class: 'stage' });
  private body = h('div', { class: 'body' });
  /** "+ Add" and the current mode's Done button, top left of the stage. */
  private actionBar = h('div', { class: 'action-bar' });
  /** The few controls changed all the time, next to the selected character. */
  private charBar = h('div', { class: 'char-bar', hidden: true });
  private emptyNote = h('div', { class: 'empty-note', hidden: true });
  private timelineHost = h('div', { class: 'timeline' });
  private hint = h('footer', { class: 'hint' });
  private keysHelp = h('div', { class: 'keys-help', hidden: true, role: 'dialog', 'aria-label': 'Keyboard shortcuts' });

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
    this.host.replaceChildren(h('div', { class: 'editor' }, this.toolbar, this.body, this.hint, this.keysHelp));
    await this.stage.init(this.stageHost);
    this.stageHost.append(this.emptyNote, this.charBar, this.actionBar,
      h('button', { class: 'fit', title: 'Fit the frame in the window', onclick: () => { this.fitView(); this.redraw(); } }, 'Fit'));
    for (const c of project.characters) this.stage.setCharacter(c.name, c.data.imp);

    this.shot = project.shots.find((s) => s.name === ctx.shotName) ?? project.shots[0];
    if (ctx.addCharacter) this.addActor(ctx.addCharacter, false);
    this.selId = this.shot.actors.find((a) => a.character === ctx.addCharacter)?.id ?? this.shot.actors[0]?.id ?? null;
    if (ctx.addCharacter && this.selId) this.focus = 'actor';
    this.frame = Math.max(0, Math.min(this.shot.length - 1, ctx.frame ?? 0));

    await this.loadAssets();
    this.timeline = new Timeline(this, this.timelineHost);
    this.bindStage();
    this.evaluateAll();
    this.saved = this.snapshot();
    requestAnimationFrame(() => { this.fitView(); this.refresh(); });
  }

  /** Images, sounds and fonts the shot and scene use. Missing or unreadable files are skipped. */
  async loadAssets() {
    const { project } = this;
    for (const bg of this.shot.backgrounds) {
      const bytes = project.assets.get(`backgrounds/${bg.file}`);
      if (bytes) await this.stage.setBackground(bg.file, bytes).catch(() => undefined);
    }
    for (const clip of project.storyboard?.sound ?? []) {
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
  /** This shot's panel on the storyboard. */
  panel_(): Panel | null { return this.project.storyboard?.panels.find((p) => p.shot === this.shot.name) ?? null; }
  /** The scene's sound as heard in this shot: starts in this shot's frames. */
  clips(): (AudioClip & { scene: SceneClip })[] {
    const sb = this.project.storyboard, p = this.panel_();
    return sb && p ? shotClips(sb, this.project.shots, p.id) : [];
  }
  /** Where this shot starts in the scene, in frames. */
  sceneOffset(): number {
    const sb = this.project.storyboard, p = this.panel_();
    return sb && p ? panelStarts(sb, this.project.shots).get(p.id) ?? 0 : 0;
  }
  /** What is drawn for an actor: while editing the rig the selected one stands in its rest pose. */
  private shownPose(actor: Actor): Pose | null {
    const pose = this.pose(actor), rig = this.rig(actor);
    if (!pose || !rig?.views[pose.view]) return null;
    if (this.mode === 'rig' && actor.id === this.selId) return { ...restPose(rig.views[pose.view]!, pose.view, pose.root), scale: pose.scale };
    return pose;
  }

  // --- selection ---------------------------------------------------------------
  /** Pick what the inspector shows. Characters stay current for the timeline even when something else is picked. */
  select(focus: Focus, id: string | null = null) {
    if (this.mode !== 'pose' && !(focus === 'actor' && id === this.selId)) this.setMode('pose', false);
    this.focus = focus;
    if (focus === 'actor' && id && id !== this.selId) { this.selId = id; this.selJoint = null; }
    this.selBg = focus === 'layer' ? id : null;
    this.selText = focus === 'text' ? id : null;
    this.selClip = focus === 'clip' ? id : null;
  }
  setMode(mode: Mode, refresh = true) {
    if (mode === this.mode) return;
    if (this.mode === 'capture') stopWebcam(); // the camera is only on while capturing
    this.mode = mode;
    if (mode !== 'pose') this.focus = 'actor';
    this.selJoint = null;
    if (refresh) this.refresh();
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
    if (actor.role === 'extra') { actor.base = clone(pose); return; } // extras hold one pose (or loop)
    if (this.autoKey) {
      // Auto-record: the pose is stored on this frame, so posing two frames gives an animation straight away.
      if (!actor.keys.length) actor.base = clone(pose);
      setKey(actor, this.frame, pose);
      this.unsaved.delete(actor.id);
      this.say(`Pose saved · frame ${this.frame + 1}`);
    } else if (!actor.keys.length) actor.base = clone(pose); // not animated yet: this is simply its pose
    else if (keyAt(actor, this.frame)) { setKey(actor, this.frame, pose); this.unsaved.delete(actor.id); }
    else this.unsaved.add(actor.id); // shown, but lost on leaving the frame unless keyed
  }

  setKeyHere(actor = this.sel()) {
    const pose = this.pose(actor);
    if (!actor || !pose || actor.role === 'extra') return;
    setKey(actor, this.frame, pose);
    this.unsaved.delete(actor.id);
    this.refresh();
    this.say(`Key set · frame ${this.frame + 1}`);
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
    if (opts.scrub) this.audio.scrub(this.clips(), f);
    this.redraw();
    this.timeline.draw();
    if (!this.playing && !opts.scrub) { this.timeline.renderBar(); this.renderPanel(); }
  }

  play() {
    if (this.playing) return this.stop();
    this.playing = true;
    if (this.frame >= this.shot.length - 1) this.frame = 0;
    const from = this.frame, t0 = performance.now();
    this.audio.play(this.clips(), from);
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
    const was = this.playing;
    this.playing = false;
    cancelAnimationFrame(this.playTimer);
    this.audio.stop();
    if (was) { this.timeline.renderBar(); this.renderPanel(); }
  }

  // --- adding things ---------------------------------------------------------------
  /** Put a character on the stage, sized to sit comfortably in a 1080-tall frame. */
  addActor(character: string, refresh = true): Actor | null {
    const entry = this.project.characters.find((c) => c.name === character);
    const actor = entry && placeActor(this.shot, character, entry.data.rig);
    if (!entry || !actor) return null;
    this.shot.actors.push(actor);
    if (!this.stage.hasCharacter(character)) this.stage.setCharacter(character, entry.data.imp);
    this.select('actor', actor.id);
    if (refresh) { this.evaluateAll(); this.refresh(); }
    return actor;
  }

  /**
   * Ask for image files and add each as a layer lasting the whole shot. A background covers the stage and starts
   * locked, so dragging a character never moves it by accident. A foreground starts small, in the middle of the frame.
   */
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
            const scale = Math.round((front ? Math.min(1, (cam.width * 0.3) / size.w) : Math.max(stage.w / size.w, stage.h / size.h)) * 100) / 100;
            const centre = front ? { x: cam.x, y: cam.y } : { x: stage.w / 2, y: stage.h / 2 };
            const layer = { id: uid(), file: name, scale, front: front || undefined, locked: front ? undefined : true, x: centre.x - (size.w * scale) / 2, y: centre.y - (size.h * scale) / 2 };
            // A background goes to the very back, a foreground to the very front.
            const order = stackOrder(this.shot);
            this.shot.backgrounds.push(layer);
            this.shot.order = front ? [...order, layer.id] : [layer.id, ...order];
            this.select('layer', layer.id);
          } catch (err) { this.say(err instanceof Error ? err.message : String(err)); }
        }
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
    this.select('text', item.id);
    this.refresh();
  }
  /** Remove whatever image, text, sound or character is selected. Undo brings it back. */
  removeSelected() {
    const { shot } = this;
    if (this.focus === 'layer' && this.selBg) shot.backgrounds = shot.backgrounds.filter((b) => b.id !== this.selBg);
    else if (this.focus === 'text' && this.selText) shot.texts = shot.texts.filter((t) => t.id !== this.selText);
    else if (this.focus === 'clip' && this.selClip && this.project.storyboard?.sound) this.project.storyboard.sound = this.project.storyboard.sound.filter((c) => c.id !== this.selClip);
    else if (this.focus === 'actor' && this.selId) {
      shot.actors = shot.actors.filter((a) => a.id !== this.selId);
      this.selId = shot.actors[0]?.id ?? null;
      this.evaluateAll();
    } else return;
    this.select('shot');
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
      shot: this.shot, frame: this.frame, selId: this.selId, sound: this.project.storyboard?.sound ?? null,
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
    for (const k of Object.keys(this.shot)) if (!(k in s.shot)) delete (this.shot as unknown as Record<string, unknown>)[k];
    Object.assign(this.shot, s.shot);
    this.frame = s.frame;
    this.selId = s.selId;
    if (this.project.storyboard) this.project.storyboard.sound = s.sound ?? undefined;
    this.project.poses.splice(0, this.project.poses.length, ...s.library.map((p: SavedPose) => ({ ...p, thumb: this.thumbs.get(p.name) })));
    this.project.characters.forEach((c, i) => { if (s.rigs[i]) Object.assign(c.data.rig, s.rigs[i]); });
    this.poses = new Map(s.poses);
    this.unsaved = new Set(s.unsaved);
    // Whatever was selected may be gone.
    if (this.selBg && !this.shot.backgrounds.some((b) => b.id === this.selBg)) this.select('shot');
    if (this.selText && !this.shot.texts.some((t) => t.id === this.selText)) this.select('shot');
    if (this.selClip && !this.project.storyboard?.sound?.some((c) => c.id === this.selClip)) this.select('shot');
    if (this.focus === 'actor' && !this.sel()) this.select('shot');
    this.ctx.onChanged();
    void this.loadAssets().then(() => this.refresh());
  }
  undo = () => this.restore(this.undoStack, this.redoStack);
  redo = () => this.restore(this.redoStack, this.undoStack);

  // --- drawing ---------------------------------------------------------------
  private drawActors(): DrawActor[] {
    const out: DrawActor[] = [];
    for (const a of this.shot.actors) {
      if (a.hidden) continue;
      const rig = this.rig(a), pose = this.shownPose(a);
      if (rig && pose) out.push({ id: a.id, rig, pose, unlocked: this.unlocked(a), extra: a.role === 'extra' && a.id !== this.selId });
    }
    return out;
  }
  /** Handles on the selected character: IK handles while posing, every pivot while editing the rig. */
  private markers(): { list: Marker[]; ids: (Drag | null)[] } {
    const list: Marker[] = [], ids: (Drag | null)[] = [];
    const actor = this.sel(), v = this.view(), pose = actor && this.shownPose(actor);
    if (!actor || actor.hidden || !v || !pose || this.focus !== 'actor' || (this.mode !== 'rig' && this.mode !== 'pose')) return { list, ids };
    const unlocked = this.unlocked(), mats = boneMatrices(v, pose, unlocked);
    if (this.mode === 'rig') {
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
      shot: this.shot, actors, order: stackOrder(this.shot),
      texts: visibleTexts(this.shot, this.frame), layers: visibleLayers(this.shot, this.frame).filter((l) => !l.hidden),
      ghosts: this.onion && this.mode === 'pose' && sel && selDraw ? { actor: selDraw, poses: this.ghostPoses(sel) } : undefined,
    }, guide ?? { format: this.format(), camera: this.camera() });
    let box: Rect | null = null;
    if (this.mode === 'place' && sel && selDraw) box = this.stage.actor({ id: sel.id, rig: this.rig(sel)! })?.bounds() ?? null;
    if (this.focus === 'layer' && this.selBg) {
      const bg = this.shot.backgrounds.find((b) => b.id === this.selBg), size = bg && this.stage.backgroundSize(bg.file);
      if (bg && size && !bg.hidden) box = { x: bg.x, y: bg.y, w: size.w * bg.scale, h: size.h * bg.scale };
    }
    this.stage.drawOverlay(this.markers().list, guide && { ...guide, active: this.focus === 'camera' }, this.shot.stage, box);
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

  /** The stage's own controls: + Add (or Done, in a mode), the selected character's bar, and the empty-stage note. */
  renderBars() {
    const { project, shot } = this, actor = this.sel(), pose = this.pose(), rig = this.rig(), v = this.view();
    const close = (e: Event) => (e.target as HTMLElement).closest('details')?.removeAttribute('open');
    // Characters already in this scene come first, so a scene's cast is quick to reuse.
    const inScene = new Set(project.shots.flatMap((s) => s.actors.map((a) => a.character)));
    const chars = [...project.characters].sort((a, b) => Number(inScene.has(b.name)) - Number(inScene.has(a.name)));
    const addMenu = h('details', { class: 'menu add-menu', id: 'add' },
      h('summary', { class: 'primary' }, '+ Add'),
      h('div', { class: 'menu-items' },
        h('p', { class: 'menu-head' }, 'Character'),
        chars.map((c) => h('button', { 'data-add-character': c.name, onclick: (e: Event) => { close(e); this.addActor(c.name); } },
          c.name, inScene.has(c.name) ? h('span', { class: 'meta' }, ' · in this scene') : null)),
        h('button', { id: 'add-import', onclick: (e: Event) => { close(e); this.ctx.importCharacter(); } }, 'Import a new character…'),
        h('hr', {}),
        h('button', { id: 'add-background', onclick: (e: Event) => { close(e); this.addImageLayer(false); } }, 'Background image…'),
        h('button', { id: 'add-foreground', onclick: (e: Event) => { close(e); this.addImageLayer(true); } }, 'Foreground image…'),
        h('button', { id: 'add-text', onclick: (e: Event) => { close(e); this.addTextLayer(); } }, 'Text')));
    const done = (label: string) => h('button', { class: 'primary', id: 'mode-done', onclick: () => this.setMode('pose') }, label);
    this.actionBar.replaceChildren(
      this.mode === 'rig' ? done('Done editing the rig') : this.mode === 'place' ? done('Done placing') : this.mode === 'capture' ? done('Done') : addMenu);

    // An empty stage says what to do next.
    this.emptyNote.hidden = shot.actors.length > 0 || shot.backgrounds.length > 0;
    if (!this.emptyNote.hidden) this.emptyNote.replaceChildren(...[
      h('p', {}, project.characters.length ? 'This shot is empty. Add a character or an image with + Add, top left.' : 'Start by importing a character.'),
      project.characters.length ? null : h('button', { class: 'primary', onclick: () => this.ctx.importCharacter() }, 'Import a character'),
    ].filter((n): n is HTMLButtonElement | HTMLParagraphElement => !!n));

    // View, flip, mouth and hands live on the character, since they change all the time.
    const show = this.mode === 'pose' && this.focus === 'actor' && !!actor && !actor.hidden && !!pose && !!rig && !!v;
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

  renderPanel() { renderInspector(this); }

  /** A short message in the bar at the bottom. */
  say(text: string) {
    this.hint.textContent = text;
    this.hint.classList.add('notice');
    clearTimeout(this.sayTimer);
    this.sayTimer = window.setTimeout(() => { this.hint.classList.remove('notice'); this.hint.textContent = this.hintText(); }, 6000);
  }
  private sayTimer = 0;
  private hintText() { return this.focus === 'camera' && this.mode === 'pose' ? HINTS.camera : HINTS[this.mode]; }
  /** Result of the last video export, for the checks in /scripts. */
  lastExport: { bytes: Uint8Array; video: string; audio: string | null } | null = null;

  /**
   * One finished frame of the shot at the output shape's exact size (or smaller, for a preview).
   * Leaves the stage drawn for output: redraw() afterwards to get the editor view back.
   */
  outputFrame(frame: number, burnSubtitles: boolean, scale = 1): HTMLCanvasElement {
    const out = finishedFrame(this.project, this.shot, frame, { subtitles: burnSubtitles });
    // On the frame being edited, show the poses on screen (a change not yet keyed included).
    if (frame === this.frame) for (const a of out.actors) a.pose = this.pose(this.shot.actors.find((x) => x.id === a.id)!) ?? a.pose;
    this.stage.draw(out, { format: this.format(), camera: this.camera() });
    return this.stage.renderFrame(this.format(), this.camera(), scale);
  }

  /** Commit the finished action and bring every part of the screen up to date. */
  refresh() {
    if (this.disposed) return;
    if (!this.drag) this.commit();
    this.renderBars();
    this.redraw();
    this.renderToolbar();
    this.renderPanel();
    this.timeline.render();
    if (!this.hint.classList.contains('notice')) this.hint.textContent = this.hintText();
  }

  renderToolbar() {
    const { ctx } = this;
    this.toolbar.replaceChildren(
      h('button', { id: 'to-storyboard', title: 'Back to the storyboard (Ctrl+↑)', onclick: ctx.back }, '← Storyboard'),
      renderFilmstrip(this),
      h('button', { id: 'undo', title: 'Undo (Ctrl+Z)', disabled: !this.undoStack.length, onclick: this.undo }, 'Undo'),
      h('button', { id: 'redo', title: 'Redo (Ctrl+Shift+Z)', disabled: !this.redoStack.length, onclick: this.redo }, 'Redo'),
      h('button', { id: 'open-export', class: this.focus === 'export' ? 'selected' : '', onclick: () => { this.select('export'); this.refresh(); } }, 'Export'),
      h('span', { class: 'save-state', id: 'save-state', role: 'status' }, ctx.saveState()),
      h('details', { class: 'menu' },
        h('summary', {}, 'Project'),
        h('div', { class: 'menu-items' },
          h('p', { class: 'meta save-status' }, ctx.status()),
          h('button', { onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); this.showKeys(true); } }, 'Keyboard shortcuts'),
          ctx.menu().map((m) => h('button', { onclick: (e: Event) => { (e.target as HTMLElement).closest('details')!.removeAttribute('open'); m.run(); } }, m.label)))),
    );
    // Keep the current shot in view in the filmstrip.
    this.toolbar.querySelector<HTMLElement>('.film.current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** The keyboard shortcut list. */
  showKeys(show = this.keysHelp.hidden) {
    const wasHidden = this.keysHelp.hidden;
    this.keysHelp.hidden = !show;
    if (!show) return;
    this.keysHelp.replaceChildren(h('div', { class: 'keys-card' },
      h('div', { class: 'row' }, h('h2', {}, 'Keyboard shortcuts'), h('button', { id: 'keys-close', onclick: () => this.showKeys(false) }, 'Close')),
      h('dl', {}, SHORTCUTS.flatMap(([keys, join, what]) => [h('dt', {}, keys.flatMap((k, i) => [i ? ` ${join} ` : '', h('kbd', {}, k)])), h('dd', {}, what)]))));
    if (wasHidden) enter(this.keysHelp.firstElementChild as HTMLElement, 'scale(0.97)', 180, EASE_OUT);
    (this.keysHelp.querySelector('#keys-close') as HTMLElement).focus();
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

  /** The topmost thing under a point that can be picked: text first, then the stack from the front. Hidden and locked things are skipped. */
  private pick(world: Pt): { kind: 'text'; id: string } | { kind: 'actor'; id: string; bone: BoneId } | { kind: 'layer'; id: string } | null {
    const text = visibleTexts(this.shot, this.frame).filter((t) => t.kind === 'text').reverse()
      .find((t) => Math.abs(world.y - t.y) < t.size * 0.9 && Math.abs(world.x - t.x) < Math.max(t.size, t.text.length * t.size * 0.35));
    if (text) return { kind: 'text', id: text.id };
    const layers = visibleLayers(this.shot, this.frame);
    for (const id of [...stackOrder(this.shot)].reverse()) {
      const a = this.shot.actors.find((x) => x.id === id);
      if (a) {
        const rig = this.rig(a);
        if (a.hidden || a.locked || !rig) continue;
        const hit = this.stage.actor({ id: a.id, rig })?.hit(world);
        if (hit) return { kind: 'actor', id: a.id, bone: hit.bone };
        continue;
      }
      const l = layers.find((x) => x.id === id);
      if (l && !l.hidden && !l.locked && this.stage.hitBackground([l], world)) return { kind: 'layer', id: l.id };
    }
    return null;
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
    const cameraCorner = (screen: Pt): Pt | null => {
      const r = cameraRect(this.camera(), this.format());
      const corners = [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
      for (let i = 0; i < 4; i++) {
        const s = this.stage.worldToScreen({ x: corners[i][0], y: corners[i][1] });
        if (Math.hypot(s.x - screen.x, s.y - screen.y) < 14) return { x: corners[3 - i][0], y: corners[3 - i][1] }; // the opposite corner stays put
      }
      return null;
    };

    canvas.addEventListener('pointerdown', (e) => {
      const screen = screenPt(e), world = this.stage.screenToWorld(screen);
      canvas.setPointerCapture(e.pointerId);
      this.dragMoved = false;
      if (this.playing) this.stop();
      if (e.button === 1 || this.spaceDown) { this.drag = { type: 'pan', last: screen }; return; }
      if (e.button !== 0) return;
      // A plain left-drag never moves the view: that is Space+drag, the middle button or the trackpad.

      // The camera, while it is selected: drag inside to move it, a corner to resize it.
      if (this.focus === 'camera') {
        const anchor = cameraCorner(screen), r = cameraRect(this.camera(), this.format());
        const inside = world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h;
        if (anchor || inside) {
          this.drag = anchor ? { type: 'cameraSize', anchor } : { type: 'camera', last: world };
          if (this.formatId !== 'yt') this.camera().custom = true;
          this.refresh();
          return;
        }
      }

      const marker = markerAt(screen, 12);
      if (this.mode === 'rig') {
        const hit = this.pick(world);
        if (marker) {
          this.drag = marker;
          this.selJoint = marker.type === 'pivot' ? marker.joint : marker.type === 'rootPivot' ? 'root' : this.selJoint;
        } else if (hit?.kind === 'actor' && hit.id === this.selId) this.selJoint = this.bendableJoint(hit.bone);
        else this.selJoint = null;
        this.refresh();
        return;
      }
      if (this.mode === 'capture') return;

      // Posing handles on the selected character come before anything under them.
      if (this.mode === 'pose' && marker?.type === 'ik') {
        const hit = this.pick(world);
        if (!(e.altKey && hit?.kind === 'actor' && hit.id === this.selId)) {
          this.drag = marker;
          this.selJoint = LIMBS.find((l) => l.id === marker.limb)!.lower;
          this.refresh();
          return;
        }
      }

      const hit = this.pick(world);
      if (!hit) { this.select('shot'); this.selJoint = null; this.refresh(); return; }
      if (hit.kind === 'text') { this.select('text', hit.id); this.drag = { type: 'text', id: hit.id, last: world }; this.refresh(); return; }
      if (hit.kind === 'layer') { this.select('layer', hit.id); this.drag = { type: 'background', id: hit.id, last: world }; this.refresh(); return; }

      // A character.
      if (this.mode === 'place') {
        if (hit.id !== this.selId) { this.selId = hit.id; this.focus = 'actor'; }
        this.drag = { type: 'place', last: world };
        this.refresh();
        return;
      }
      this.select('actor', hit.id);
      const joint = this.bendableJoint(hit.bone);
      const limb = LIMBS.find((l) => JOINT_BY_ID[l.end].bone === hit.bone);
      if (joint === 'root') this.drag = e.shiftKey ? { type: 'rootRotate', last: world } : { type: 'move', last: world };
      else if (limb && !e.altKey && this.ikLimbs().includes(limb)) this.drag = { type: 'ik', limb: limb.id };
      else this.drag = { type: 'fk', joint, last: world };
      this.selJoint = this.drag.type === 'ik' ? limb!.lower : joint;
      this.refresh();
    });

    canvas.addEventListener('pointermove', (e) => {
      const drag = this.drag;
      const screen = screenPt(e), world = this.stage.screenToWorld(screen);
      if (!drag) {
        canvas.style.cursor = this.spaceDown ? 'grab' : markerAt(screen, 12) || this.pick(world) ? 'grab' : 'default';
        return;
      }
      this.dragMoved = true;
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
      if (this.dragMoved && ['fk', 'ik', 'move', 'rootRotate'].includes(drag.type)) this.edited();
      this.refresh();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    // Trackpad: two fingers move the view, pinch zooms (the browser reports a pinch as Ctrl+wheel).
    // Mouse: the wheel scrolls the view, Ctrl+wheel zooms.
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // A pinch sends many small steps; a mouse wheel notch sends one big one (about 100 px or 3 lines).
        const k = e.deltaMode ? 0.05 : Math.abs(e.deltaY) >= 50 ? 0.0015 : 0.01;
        this.stage.zoomAt(screenPt(e), Math.exp(-e.deltaY * k));
      } else {
        const line = e.deltaMode === 1 ? 16 : 1; // some mice report lines, not pixels
        this.stage.panBy(-(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * line, -(e.shiftKey && !e.deltaX ? 0 : e.deltaY) * line);
      }
      this.redraw();
    }, { passive: false });

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.matches('input[type="number"], input[type="text"], input[type="search"], textarea, select');
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && !e.altKey && !typing) {
        const key = e.key.toLowerCase();
        if (key === 'z' || key === 'y') { e.preventDefault(); if (key === 'y' || e.shiftKey) this.redo(); else this.undo(); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); this.ctx.back(); return; }
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (el.matches('button, input, summary')) el.blur();
        // Tap Space to play or stop; hold it and drag to pan.
        if (e.type === 'keydown' && !e.repeat) this.spaceDown = true;
        if (e.type === 'keyup') { this.spaceDown = false; if (!this.drag && !this.spacePanned) this.play(); this.spacePanned = false; }
        return;
      }
      if (e.type !== 'keydown') return;
      const key = e.key;
      if (key === '?') { e.preventDefault(); this.showKeys(); return; }
      if (key === 'Escape') {
        if (!this.keysHelp.hidden) { this.showKeys(false); return; }
        if (document.querySelector('details.menu[open]')) return; // the menu closes first
        if (this.mode !== 'pose') this.setMode('pose');
        else if (this.focus !== 'shot') { this.select('shot'); this.selJoint = null; this.refresh(); }
        return;
      }
      if (key.toLowerCase() === 'k') { e.preventDefault(); this.setKeyHere(); return; }
      if (key === ',' || key === '.') { e.preventDefault(); this.setFrame(this.frame + (key === ',' ? -1 : 1)); return; }
      if (key === '[' || key === ']') { e.preventDefault(); this.stepShot(key === '[' ? -1 : 1); return; }
      if (key === '\\') { e.preventDefault(); this.timeline.toggleZoom(); return; }
      if ((key === 'Delete' || key === 'Backspace') && this.focus !== 'shot' && this.focus !== 'export' && this.focus !== 'camera') {
        e.preventDefault(); this.removeSelected(); return;
      }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        if (el.matches('[role="slider"], input')) return;
        e.preventDefault();
        this.setFrame(this.frame + (key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 12 : 1));
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    canvas.addEventListener('pointerdown', () => { if (this.spaceDown) this.spacePanned = true; });
    const observer = new ResizeObserver(() => requestAnimationFrame(() => { if (this.disposed) return; this.stage.app.resize(); this.redraw(); this.timeline.draw(); }));
    observer.observe(this.stageHost);
    this.disposers.push(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); observer.disconnect(); });
  }

  /** The previous or next panel on the storyboard. */
  stepShot(dir: -1 | 1) {
    const panels = this.project.storyboard?.panels ?? [], here = this.panel_();
    const next = here ? panels[panels.indexOf(here) + dir] : undefined;
    if (next) this.ctx.openPanel(next);
  }

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
