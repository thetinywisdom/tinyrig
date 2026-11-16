// Characters: where each drawing gets its joints. Pick a character, pick an angle (front, 3/4, side, back),
// drag each dot to where that part turns. Drag a body part to try the joints; nothing you try is kept.
import { apply, boneMatrices, canBend, clampToLimit, restPose, swingAround } from '../model/pose';
import { newShot } from '../model/shot';
import { JOINTS, JOINT_OF_BONE, LIMBS, ROOT_BONE, unlockedJoints, VIEWS, VIEW_LABEL, type BoneId, type JointId, type ViewId } from '../model/skeleton';
import type { Pose, Pt } from '../model/types';
import type { Project } from '../project/project';
import { StageView, type Marker } from '../render/stage';
import { pictures } from '../render/thumb';
import { h } from './dom';

export interface CharactersContext {
  project: Project;
  onChanged: () => void;
  back: () => void;
  importCharacter: () => void;
  /** Character to show first (just imported). */
  show?: string;
}

const PROPER_NAME: Record<ViewId, string> = { front: 'front', quarter: 'three_quarter', side: 'side', back: 'back' };

export class CharactersView {
  private name: string | null;
  private view: ViewId = 'front';
  /** A pose you are trying out on the drawing. Never stored. */
  private trial: Pose | null = null;
  private stage = new StageView();
  private ready: Promise<void>;
  private loaded = new Set<string>();
  private drag: { kind: 'pivot'; joint: JointId | 'root' } | { kind: 'bend'; joint: JointId; last: Pt } | null = null;
  private root = h('div', { class: 'chars' });
  private top = h('header', { class: 'act-top' });
  private list = h('aside', { class: 'chars-list', 'aria-label': 'Characters' });
  private main = h('main', { class: 'chars-main' });
  private tabs = h('div', { class: 'chars-tabs', role: 'group', 'aria-label': 'Angle' });
  private stageHost = h('div', { class: 'chars-stage' });
  private below = h('div', { class: 'chars-below' });
  private disposers: (() => void)[] = [];

  constructor(host: HTMLElement, private ctx: CharactersContext) {
    this.name = ctx.show ?? ctx.project.characters[0]?.name ?? null;
    this.main.append(this.tabs, this.stageHost, this.below);
    this.root.append(this.top, h('div', { class: 'chars-body' }, this.list, this.main));
    host.replaceChildren(this.root);
    this.ready = this.stage.init(this.stageHost);
    void this.ready.then(() => { this.bindStage(); this.draw(); });
    const obs = new ResizeObserver(() => void this.ready.then(() => requestAnimationFrame(() => { if (!this.disposed) { this.stage.app.resize(); this.draw(true); } })));
    obs.observe(this.stageHost);
    this.disposers.push(() => obs.disconnect());
    this.pickFirstView();
    this.render();
  }

  private entry() { return this.ctx.project.characters.find((c) => c.name === this.name) ?? null; }
  private rig() { return this.entry()?.data.rig ?? null; }
  private rigView() { return this.rig()?.views[this.view] ?? null; }
  private pickFirstView() {
    const rig = this.rig();
    if (rig && !rig.views[this.view]) this.view = VIEWS.find((v) => rig.views[v]) ?? 'front';
  }

  render() {
    const { project } = this.ctx;
    this.top.replaceChildren(
      h('button', { id: 'chars-back', onclick: () => this.ctx.back() }, '← Storyboard'),
      h('strong', { class: 'act-title' }, 'Characters'),
      h('span', { class: 'grow' }),
      h('button', { id: 'chars-import', class: project.characters.length ? '' : 'primary', onclick: () => this.ctx.importCharacter() }, '+ Import a character'));
    this.list.replaceChildren(...project.characters.map((c) => h('button', {
      class: 'chars-who' + (c.name === this.name ? ' sel' : ''), 'data-character': c.name, 'aria-current': c.name === this.name ? 'true' : undefined,
      onclick: () => { this.name = c.name; this.trial = null; this.pickFirstView(); this.render(); this.draw(true); },
    }, h('b', {}, c.name), h('span', { class: 'muted' }, VIEWS.filter((v) => c.data.rig.views[v]).map((v) => VIEW_LABEL[v]).join(' · ')))));
    const rig = this.rig();
    if (!rig) {
      this.tabs.replaceChildren();
      this.below.replaceChildren(h('div', { class: 'act-card' }, h('h1', {}, 'No characters yet'),
        h('p', { class: 'muted' }, 'Import one drawn in Illustrator, Figma or Procreate. Every part on its own layer, named after the part.'),
        h('button', { class: 'primary big', onclick: () => this.ctx.importCharacter() }, 'Import a character')));
      this.stageHost.hidden = true;
      return;
    }
    this.stageHost.hidden = false;
    this.tabs.replaceChildren(...VIEWS.map((v) => {
      const has = !!rig.views[v];
      return h('button', {
        class: (v === this.view ? 'on' : '') + (has ? '' : ' missing'), 'data-view': v, 'aria-pressed': String(v === this.view),
        title: has ? `${VIEW_LABEL[v]} drawing` : `No ${VIEW_LABEL[v]} drawing yet. Add a layer group named "${PROPER_NAME[v]}" to your art file and import it again.`,
        disabled: !has, onclick: () => { this.view = v; this.trial = null; this.render(); this.draw(true); },
      }, VIEW_LABEL[v]);
    }));
    const rv = this.rigView();
    const turned = this.view === 'side' || this.view === 'quarter';
    this.below.replaceChildren(
      h('p', { class: 'hint' }, this.trial ? 'Trying a pose. Nothing you try is kept.' : 'Drag each dot to where that part turns. Drag a body part to try it.'),
      h('div', { class: 'act-bar' },
        turned && rv ? h('div', { class: 'seg', role: 'group', 'aria-label': 'This drawing looks' },
          h('span', { class: 'muted seg-label' }, 'Looks'),
          (['left', 'right'] as const).map((d) => h('button', {
            class: (rv.faces ?? 'left') === d ? 'selected' : '', 'data-faces': d,
            onclick: () => { rv.faces = d; this.ctx.onChanged(); this.render(); },
          }, d === 'left' ? 'Left' : 'Right'))) : null,
        this.trial ? h('button', { id: 'chars-reset', onclick: () => { this.trial = null; this.render(); this.draw(); } }, 'Back to the drawing') : null));
  }

  // --- the drawing and its dots -------------------------------------------------------------
  private pose(): Pose | null {
    const rv = this.rigView();
    return this.trial ?? (rv ? restPose(rv, this.view) : null);
  }
  private markers(): { list: Marker[]; ids: (JointId | 'root')[] } {
    const rv = this.rigView(), rig = this.rig(), pose = this.pose();
    const list: Marker[] = [], ids: (JointId | 'root')[] = [];
    if (!rv || !rig || !pose) return { list, ids };
    const unlocked = unlockedJoints(rig.level), mats = boneMatrices(rv, pose, unlocked);
    for (const j of JOINTS) {
      if (!rv.pivots[j.id]) continue;
      list.push({ kind: 'pivot', at: apply(mats[j.parent], rv.pivots[j.id]), active: this.drag?.kind === 'pivot' && this.drag.joint === j.id, locked: !unlocked.has(j.id) });
      ids.push(j.id);
    }
    list.push({ kind: 'root', at: apply(mats[ROOT_BONE], rv.rootPivot), active: false });
    ids.push('root');
    return { list, ids };
  }

  private draw(refit = false) {
    void this.ready.then(() => {
      if (this.disposed) return;
      const entry = this.entry(), rig = this.rig(), pose = this.pose();
      if (!entry || !rig || !pose) return;
      if (!this.loaded.has(entry.name)) { this.stage.setCharacter(entry.name, entry.data.imp); this.loaded.add(entry.name); }
      const shot = newShot('characters');
      this.stage.draw({ shot, actors: [{ id: 'c', rig, pose, unlocked: unlockedJoints(rig.level), extra: false }], texts: [], layers: [] }, null);
      if (refit || !this.fitted) {
        const b = this.stage.actor({ id: 'c', rig })?.bounds();
        // Keep the view on the paper (it starts at 0, 0), so no grey shows around the drawing.
        if (b) { this.stage.fit({ x: Math.max(0, b.x - b.w * 0.25), y: Math.max(0, b.y - b.h * 0.08), w: b.w * 1.5, h: b.h * 1.16 }, 0.92); this.fitted = true; }
        this.stage.draw({ shot, actors: [{ id: 'c', rig, pose, unlocked: unlockedJoints(rig.level), extra: false }], texts: [], layers: [] }, null);
      }
      this.stage.drawOverlay(this.markers().list, null, { w: 0, h: 0 }, null);
    });
  }
  private fitted = false;

  private bindStage() {
    const canvas = this.stage.canvas;
    const at = (e: PointerEvent): Pt => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const screen = at(e), world = this.stage.screenToWorld(screen), rig = this.rig(), rv = this.rigView();
      if (!rig || !rv) return;
      const { list, ids } = this.markers();
      let best = -1, bestD = 14;
      list.forEach((m, i) => { const s = this.stage.worldToScreen(m.at), d = Math.hypot(s.x - screen.x, s.y - screen.y); if (d <= bestD) { bestD = d; best = i; } });
      canvas.setPointerCapture(e.pointerId);
      if (best >= 0 && !this.trial) { this.drag = { kind: 'pivot', joint: ids[best] }; this.draw(); return; }
      // Try the joints: drag a part to bend it around its own joint (or the nearest one above it that bends).
      const hit = this.stage.actor({ id: 'c', rig })?.hit(world);
      if (!hit) return;
      const unlocked = unlockedJoints(rig.level);
      let bone: BoneId = hit.bone, joint: JointId | null = null;
      while (bone !== ROOT_BONE) { const j = JOINT_OF_BONE[bone]; if (canBend(rv, unlocked, j.id)) { joint = j.id; break; } bone = j.parent; }
      if (!joint) return;
      this.trial ??= restPose(rv, this.view);
      this.drag = { kind: 'bend', joint, last: world };
      this.render();
    });
    canvas.addEventListener('pointermove', (e) => {
      const drag = this.drag, rig = this.rig(), rv = this.rigView();
      const world = this.stage.screenToWorld(at(e));
      if (!rig || !rv) return;
      if (!drag) { canvas.style.cursor = this.stage.actor({ id: 'c', rig })?.hit(world) ? 'grab' : 'default'; return; }
      if (drag.kind === 'pivot') {
        // The drawing stands at rest, so the stage point is the pivot.
        if (drag.joint === 'root') rv.rootPivot = world;
        else {
          rv.pivots[drag.joint] = world;
          const limb = LIMBS.find((l) => l.end === drag.joint);
          if (limb) rv.tips[limb.id] = { ...world };
        }
      } else if (this.trial) {
        const j = JOINTS.find((x) => x.id === drag.joint)!;
        const mats = boneMatrices(rv, this.trial, unlockedJoints(rig.level));
        const delta = swingAround(mats[j.parent], rv.pivots[j.id], drag.last, world);
        this.trial.angles[j.id] = clampToLimit((this.trial.angles[j.id] ?? 0) + delta, rig.limits[j.id]);
        drag.last = world;
      }
      this.draw();
    });
    const end = () => {
      if (!this.drag) return;
      const wasPivot = this.drag.kind === 'pivot';
      this.drag = null;
      if (wasPivot) { pictures.forget(this.name ?? ''); this.ctx.onChanged(); }
      this.draw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  private disposed = false;
  dispose() {
    this.disposed = true;
    for (const d of this.disposers) d();
    void this.ready.then(() => this.stage.destroy());
  }
}
