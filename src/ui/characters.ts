// Characters: where each drawing gets its rig. Pick a character, pick an angle (front, 3/4, side, back).
// The rig is a tree of named nodes: drag a node to where its part turns, drop a node on another to connect
// them, click a part and then a node to say which node moves it. A layer named like a node attaches by itself.
// Drag a part to try a bend; nothing you try is kept.
import { applyKind, guessNodePoint } from '../import/build';
import { apply, boneMatrices, canBend, clampToLimit, restPose, swingAround } from '../model/pose';
import {
  attachByName, bonesBelow, DETAIL_LABEL, displayName, newNodeId, nodesOf, RIG_KIND_LABEL, RIG_KINDS, rootNode, skeletonOf, unlockedOf, viewBox,
  type RigKind,
} from '../model/rig';
import { newShot } from '../model/shot';
import { LEVELS, LIMBS, VIEWS, VIEW_LABEL, type BoneId, type JointId, type RigLevel, type ViewId } from '../model/skeleton';
import type { Pose, Pt, Rig, RigNode } from '../model/types';
import type { Project } from '../project/project';
import { StageView } from '../render/stage';
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
const SVG = 'http://www.w3.org/2000/svg';
const HIT = 14; // px around a dot that grabs it

interface Dot { node: RigNode; at: Pt; screen: Pt }
type Drag =
  | { kind: 'node'; id: string; from: Pt; moved: boolean; over: string | null }
  | { kind: 'part'; start: Pt; piece: string; bone: BoneId }
  | { kind: 'bend'; joint: JointId; last: Pt };

export class CharactersView {
  private name: string | null;
  private view: ViewId = 'front';
  /** A pose you are trying out on the drawing. Never stored. */
  private trial: Pose | null = null;
  private stage = new StageView();
  private ready: Promise<void>;
  private loaded = new Set<string>();
  private drag: Drag | null = null;
  /** The node or layer you picked, and whether the next click on the drawing places a new node. */
  private selNode: string | null = null;
  private selLayer: string | null = null;
  private adding = false;
  /** The node under the pointer: its name always shows. */
  private hover: string | null = null;
  private note = '';
  private undo: { name: string; rig: string }[] = [];
  private root = h('div', { class: 'chars' });
  private top = h('header', { class: 'act-top' });
  private list = h('aside', { class: 'chars-list', 'aria-label': 'Characters' });
  private main = h('main', { class: 'chars-main' });
  private side = h('aside', { class: 'chars-rig', 'aria-label': 'Rig' });
  private tabs = h('div', { class: 'chars-tabs', role: 'group', 'aria-label': 'Angle' });
  private stageHost = h('div', { class: 'chars-stage' });
  private marks = document.createElementNS(SVG, 'svg');
  private below = h('div', { class: 'chars-below' });
  private disposers: (() => void)[] = [];

  constructor(host: HTMLElement, private ctx: CharactersContext) {
    this.name = ctx.show ?? ctx.project.characters[0]?.name ?? null;
    this.marks.classList.add('chars-marks');
    this.marks.setAttribute('aria-hidden', 'true');
    this.main.append(this.tabs, this.stageHost, this.below);
    this.root.append(this.top, h('div', { class: 'chars-body' }, this.list, this.main, this.side));
    host.replaceChildren(this.root);
    this.ready = this.stage.init(this.stageHost);
    void this.ready.then(() => { this.stageHost.append(this.marks); this.bindStage(); this.draw(); });
    const obs = new ResizeObserver(() => void this.ready.then(() => requestAnimationFrame(() => { if (!this.disposed) { this.stage.app.resize(); this.draw(true); } })));
    obs.observe(this.stageHost);
    const keys = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', keys);
    this.disposers.push(() => obs.disconnect(), () => window.removeEventListener('keydown', keys));
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
  private nodes(): RigNode[] { const rig = this.rig(); return rig ? nodesOf(rig) : []; }
  private nodeName(bone: BoneId | null | undefined) { return this.nodes().find((n) => n.bone === bone)?.name ?? '—'; }

  // --- changes ------------------------------------------------------------------------------
  /** Keep a copy to undo to, and make sure the rig has nodes of its own to change. */
  private begin(): Rig | null {
    const rig = this.rig();
    if (!rig || !this.name) return null;
    this.undo.push({ name: this.name, rig: JSON.stringify(rig) });
    if (this.undo.length > 50) this.undo.shift();
    if (!rig.nodes) { rig.nodes = nodesOf(rig); rig.kind = 'human'; }
    return rig;
  }
  private changed() {
    pictures.forget(this.name ?? '');
    this.ctx.onChanged();
    this.render();
    this.draw();
  }
  private undoLast() {
    const last = this.undo.pop();
    if (!last) return;
    const entry = this.ctx.project.characters.find((c) => c.name === last.name);
    if (!entry) return;
    const rig = entry.data.rig as unknown as Record<string, unknown>;
    for (const k of Object.keys(rig)) delete rig[k];
    Object.assign(rig, JSON.parse(last.rig));
    this.name = last.name;
    this.note = '';
    this.changed();
  }

  private setKind(kind: RigKind) {
    const entry = this.entry(), rig = this.begin();
    if (!entry || !rig) return;
    applyKind(rig, entry.data.imp, kind, rig.level);
    this.selNode = this.selLayer = null;
    this.trial = null;
    this.note = `${RIG_KIND_LABEL[kind]} rig. Layers named like a node move with it.`;
    this.changed();
  }

  /** Simple, Medium or Complex: fewer or more nodes. Your own nodes, names and points stay. */
  private setDetail(level: RigLevel) {
    const entry = this.entry(), rig = this.begin();
    if (!entry || !rig) return;
    applyKind(rig, entry.data.imp, rig.kind ?? 'human', level);
    if (this.selNode && !rig.nodes!.some((n) => n.id === this.selNode)) this.selNode = null;
    this.trial = null;
    this.note = `${DETAIL_LABEL[level]} rig: ${rig.nodes!.length} nodes.`;
    this.changed();
  }

  private rename(node: RigNode, name: string) {
    name = name.trim();
    if (!name || name === node.name) { this.render(); return; }
    const rig = this.begin();
    if (!rig) return;
    const renamed = rig.nodes!.find((n) => n.id === node.id)!;
    renamed.name = name;
    attachByName(rig, renamed);
    this.changed();
  }

  /** Connect: the node moves with `to` from now on. */
  private connect(id: string, to: RigNode) {
    const nodes = this.nodes(), node = nodes.find((n) => n.id === id);
    if (!node) return;
    if (!node.parent) { this.note = `${node.name} moves everything. Drop other nodes on it instead.`; return; }
    if (bonesBelow(nodes, node.bone).has(to.bone)) { this.note = `${to.name} already moves with ${node.name}.`; return; }
    if (node.parent === to.bone) return;
    const rig = this.begin();
    if (!rig) return;
    rig.nodes!.find((n) => n.id === id)!.parent = to.bone;
    this.note = `${node.name} now moves with ${to.name}.`;
    this.changed();
  }

  /** Which node moves a layer, in every angle. */
  private attach(layer: string, to: RigNode) {
    const rig = this.begin();
    if (!rig) return;
    for (const rv of Object.values(rig.views)) {
      for (const [name, p] of Object.entries(rv?.pieces ?? {})) if (name === layer || (p.slot === layer && !p.overlay)) p.bone = to.bone;
    }
    this.note = `${displayName(layer)} moves with ${to.name}.`;
    this.selLayer = null;
    this.changed();
  }

  /** A new node where you clicked: named after the picked layer (which it then moves), or "Node N". */
  private addNode(at: Pt, onBone: BoneId | null) {
    const entry = this.entry(), rig = this.begin(), rv = this.rigView();
    if (!entry || !rig || !rv) return;
    const nodes = rig.nodes!;
    const layer = this.selLayer;
    const parentBone = (layer ? rv.pieces[layer]?.bone : null) ?? nodes.find((n) => n.id === this.selNode)?.bone ?? onBone ?? rootNode(nodes).bone;
    const id = newNodeId(nodes);
    let k = nodes.length;
    while (nodes.some((n) => n.name === `Node ${k}`)) k++;
    const node: RigNode = { id, bone: id, name: layer ? displayName(layer) : `Node ${k}`, parent: parentBone };
    nodes.push(node);
    rv.pivots[id] = round(at);
    if (layer) attachByName(rig, node);
    // The other angles get the node at the same spot of their drawing, or where its layer says.
    const here = viewBox(rv);
    for (const v of VIEWS) {
      const other = rig.views[v];
      if (!other || other === rv) continue;
      const box = viewBox(other);
      other.pivots[id] = guessNodePoint(rig, entry.data.imp, v, id)
        ?? round({ x: box.x + ((at.x - here.x) / here.w) * box.w, y: box.y + ((at.y - here.y) / here.h) * box.h });
    }
    this.adding = false;
    this.selLayer = null;
    this.selNode = id;
    this.note = '';
    this.changed();
    // Name it right away.
    requestAnimationFrame(() => {
      const input = this.side.querySelector<HTMLInputElement>(`[data-node="${id}"] input`);
      if (input && !layer) { input.focus(); input.select(); }
    });
  }

  /** Put a node that this angle does not have yet where you clicked. */
  private place(id: string, at: Pt) {
    const rig = this.begin(), rv = this.rigView();
    if (!rig || !rv) return;
    rv.pivots[id] = round(at);
    this.changed();
  }

  private remove(id: string) {
    const nodes = this.nodes(), node = nodes.find((n) => n.id === id);
    if (!node || !node.parent) return;
    const rig = this.begin();
    if (!rig) return;
    rig.nodes = rig.nodes!.filter((n) => n.id !== id);
    for (const n of rig.nodes) if (n.parent === node.bone) n.parent = node.parent;
    for (const rv of Object.values(rig.views)) {
      if (!rv) continue;
      delete rv.pivots[id];
      for (const p of Object.values(rv.pieces)) if (p.bone === node.bone) p.bone = node.parent;
    }
    if (this.selNode === id) this.selNode = null;
    this.note = `${node.name} removed. Its parts move with ${this.nodeName(node.parent)}.`;
    this.changed();
  }

  private onKey(e: KeyboardEvent) {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); this.undoLast(); return; }
    if (typing) return;
    if (e.key === 'Escape' && (this.adding || this.selLayer || this.selNode)) {
      e.stopPropagation();
      this.adding = false; this.selLayer = this.selNode = null; this.note = '';
      this.render(); this.draw();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selNode) {
      e.preventDefault();
      this.remove(this.selNode);
    }
  }

  // --- the page -----------------------------------------------------------------------------
  render() {
    const { project } = this.ctx;
    this.top.replaceChildren(
      h('button', { id: 'chars-back', onclick: () => this.ctx.back() }, '← Storyboard'),
      h('strong', { class: 'act-title' }, 'Characters'),
      h('span', { class: 'grow' }),
      h('button', { id: 'chars-import', class: project.characters.length ? '' : 'primary', onclick: () => this.ctx.importCharacter() }, '+ Import a character'));
    this.list.replaceChildren(...project.characters.map((c) => h('button', {
      class: 'chars-who' + (c.name === this.name ? ' sel' : ''), 'data-character': c.name, 'aria-current': c.name === this.name ? 'true' : undefined,
      onclick: () => { this.name = c.name; this.trial = null; this.selNode = this.selLayer = null; this.adding = false; this.note = ''; this.pickFirstView(); this.render(); this.draw(true); },
    }, h('b', {}, c.name), h('span', { class: 'muted' }, VIEWS.filter((v) => c.data.rig.views[v]).map((v) => VIEW_LABEL[v]).join(' · ')))));
    const rig = this.rig();
    if (!rig) {
      this.tabs.replaceChildren();
      this.side.hidden = true;
      this.below.replaceChildren(h('div', { class: 'act-card' }, h('h1', {}, 'No characters yet'),
        h('p', { class: 'muted' }, 'Import one drawn in Illustrator, Figma or Procreate. Every part on its own layer, named after the part.'),
        h('button', { class: 'primary big', onclick: () => this.ctx.importCharacter() }, 'Import a character')));
      this.stageHost.hidden = true;
      return;
    }
    this.stageHost.hidden = false;
    this.side.hidden = false;
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
      h('p', { class: 'hint', id: 'chars-hint', role: 'status' }, this.hint()),
      h('div', { class: 'act-bar' },
        turned && rv ? h('div', { class: 'seg', role: 'group', 'aria-label': 'This drawing looks' },
          h('span', { class: 'muted seg-label' }, 'Looks'),
          (['left', 'right'] as const).map((d) => h('button', {
            class: (rv.faces ?? 'left') === d ? 'selected' : '', 'data-faces': d,
            onclick: () => { rv.faces = d; this.ctx.onChanged(); this.render(); },
          }, d === 'left' ? 'Left' : 'Right'))) : null,
        this.trial ? h('button', { id: 'chars-reset', onclick: () => { this.trial = null; this.render(); this.draw(); } }, 'Back to the drawing') : null));
    this.renderSide(rig);
  }

  private hint(): string {
    const layer = this.selLayer && displayName(this.selLayer);
    const node = this.nodes().find((n) => n.id === this.selNode);
    if (this.adding) return layer ? `Click where ${layer} turns.` : 'Click where the new part turns.';
    if (layer) return `Now click the node that moves ${layer}.`;
    if (this.note) return this.note;
    if (this.trial) return 'Trying a pose. Nothing you try is kept.';
    if (node && !this.rigView()?.pivots[node.id] && node.parent) return `Click the drawing to put ${node.name} in this angle.`;
    return 'Drag a node to where its part turns. Drop it on another node to connect them.';
  }

  private renderSide(rig: Rig) {
    const rv = this.rigView();
    const nodes = nodesOf(rig), root = rootNode(nodes);
    const kind = rig.nodes ? rig.kind : 'human';
    const layers = rv ? Object.entries(rv.pieces).filter(([, p]) => !p.variant && !p.shared).sort((a, b) => b[1].z - a[1].z) : [];
    const selected = nodes.find((n) => n.id === this.selNode);
    this.side.replaceChildren(
      h('section', {},
        h('h2', {}, 'Rig'),
        h('div', { class: 'seg chars-kind', role: 'group', 'aria-label': 'Start from' },
          RIG_KINDS.map((k) => h('button', {
            class: kind === k ? 'selected' : '', 'data-kind': k, 'aria-pressed': String(kind === k),
            title: kind === k ? 'Start this rig over' : `Start from a ${RIG_KIND_LABEL[k].toLowerCase()} rig`,
            onclick: () => this.setKind(k),
          }, RIG_KIND_LABEL[k]))),
        h('div', { class: 'seg chars-kind', role: 'group', 'aria-label': 'Detail' },
          LEVELS.map((l) => h('button', {
            class: rig.level === l ? 'selected' : '', 'data-detail': l, 'aria-pressed': String(rig.level === l),
            title: l === 'low' ? 'Fewest nodes: whole arms and legs' : l === 'medium' ? 'Adds the middle joints: elbows, knees' : 'Every node: also hands, feet and the chest',
            onclick: () => this.setDetail(l),
          }, DETAIL_LABEL[l])))),
      h('section', {},
        h('div', { class: 'chars-head' },
          h('h2', {}, 'Nodes'),
          h('button', {
            id: 'chars-add', class: this.adding ? 'selected' : '', 'aria-pressed': String(this.adding),
            onclick: () => { this.adding = !this.adding; this.note = ''; this.trial = null; this.render(); this.draw(); },
          }, '+ Add a node')),
        h('ul', { class: 'chars-nodes' }, [root, ...skeletonOf({ nodes }).joints.map((j) => nodes.find((n) => n.id === j.id)!)].map((n) => {
          const placed = !n.parent || !!rv?.pivots[n.id];
          return h('li', {
            'data-node': n.id, class: (n.id === this.selNode ? 'sel' : '') + (placed ? '' : ' unplaced'),
            onclick: (e: MouseEvent) => {
              if ((e.target as HTMLElement).closest('button')) return;
              if (this.selLayer) { this.attach(this.selLayer, n); return; }
              this.selNode = n.id; this.note = ''; this.render(); this.draw();
            },
          },
          h('input', {
            value: n.name, 'aria-label': `Name of ${n.name}`, spellcheck: false,
            onchange: (e: Event) => this.rename(n, (e.target as HTMLInputElement).value),
            onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { (e.target as HTMLInputElement).value = n.name; (e.target as HTMLInputElement).blur(); } },
          }),
          h('span', { class: 'muted' }, n.parent ? (placed ? `on ${this.nodeName(n.parent)}` : 'not in this angle') : 'moves everything'),
          n.parent ? h('button', { class: 'icon', title: `Remove ${n.name}`, 'aria-label': `Remove ${n.name}`, onclick: () => this.remove(n.id) }, '×') : h('span'));
        })),
        selected && selected.parent ? h('p', { class: 'muted small' }, 'Delete removes it. Its parts then move with the node above it.') : null),
      h('section', {},
        h('h2', {}, 'Layers'),
        h('ul', { class: 'chars-layers' }, layers.map(([name, p]) => h('li', {},
          h('button', {
            'data-layer': name, class: name === this.selLayer ? 'sel' : '', 'aria-pressed': String(name === this.selLayer),
            onclick: () => { this.selLayer = this.selLayer === name ? null : name; this.trial = null; this.note = ''; this.render(); this.draw(); },
          },
          h('b', {}, displayName(name)),
          h('span', { class: 'muted' }, `→ ${this.nodeName(p.bone)}`))))),
        h('p', { class: 'muted small' }, 'Name a layer and a node the same, and they attach by themselves.')),
    );
  }

  // --- the drawing and its nodes ------------------------------------------------------------
  private pose(): Pose | null {
    const rv = this.rigView();
    return this.trial ?? (rv ? restPose(rv, this.view) : null);
  }
  private dots(): Dot[] {
    const rv = this.rigView(), rig = this.rig(), pose = this.pose();
    if (!rv || !rig || !pose) return [];
    const skel = skeletonOf(rig), mats = boneMatrices(rv, pose, unlockedOf(rig), skel);
    const nodes = nodesOf(rig), root = rootNode(nodes);
    const out: Dot[] = [];
    for (const n of nodes) {
      const at = n === root ? apply(mats[skel.root], rv.rootPivot) : rv.pivots[n.id] && n.parent && mats[n.parent] ? apply(mats[n.parent], rv.pivots[n.id]) : null;
      if (at) out.push({ node: n, at, screen: this.stage.worldToScreen(at) });
    }
    return out;
  }
  private dotAt(screen: Pt, except?: string): Dot | null {
    let best: Dot | null = null, bestD = HIT;
    for (const d of this.dots()) {
      if (d.node.id === except) continue;
      const dist = Math.hypot(d.screen.x - screen.x, d.screen.y - screen.y);
      if (dist <= bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  private drawMarks() {
    const dots = this.dots(), byBone = new Map(dots.map((d) => [d.node.bone, d]));
    const drag = this.drag?.kind === 'node' ? this.drag : null;
    const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
      const e = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      if (text) e.textContent = text;
      return e;
    };
    const out: Element[] = [];
    // Lines from each node to the node it moves with.
    for (const d of dots) {
      const p = d.node.parent ? byBone.get(d.node.parent) : null;
      if (p) out.push(el('line', { x1: p.screen.x, y1: p.screen.y, x2: d.screen.x, y2: d.screen.y, class: 'bone' }));
    }
    if (drag?.over) {
      const from = dots.find((d) => d.node.id === drag.id), to = dots.find((d) => d.node.id === drag.over);
      if (from && to) out.push(el('line', { x1: to.screen.x, y1: to.screen.y, x2: from.screen.x, y2: from.screen.y, class: 'link' }));
    }
    const labels: Element[] = [];
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const free = (b: (typeof taken)[number]) => !taken.some((t) => b.x0 < t.x1 && b.x1 > t.x0 && b.y0 < t.y1 && b.y1 > t.y0);
    const cx = dots.reduce((sum, d) => sum + d.screen.x, 0) / Math.max(1, dots.length);
    // The picked, hovered and dragged nodes are named first; the rest only where their name fits.
    const important = (d: Dot) => d.node.id === this.selNode || d.node.id === this.hover || d.node.id === drag?.id || d.node.id === drag?.over;
    for (const d of [...dots].sort((a, b) => Number(important(b)) - Number(important(a)))) {
      const sel = d.node.id === this.selNode || d.node.id === drag?.id || d.node.id === this.hover, over = d.node.id === drag?.over;
      const cls = 'dot' + (sel ? ' sel' : '') + (over ? ' over' : '') + (d.node.parent ? '' : ' root');
      out.push(d.node.parent
        ? el('circle', { cx: d.screen.x, cy: d.screen.y, r: sel || over ? 7 : 5, class: cls })
        : el('rect', { x: d.screen.x - 6, y: d.screen.y - 6, width: 12, height: 12, class: cls }));
      const text = over && drag ? `Connect to ${d.node.name}` : d.node.name;
      const w = text.length * 6.6 + 6, y = d.screen.y - 7;
      // Names sit on the outer side of the body, so left and right parts do not cover each other.
      const sides = d.screen.x < cx ? ['left', 'right'] : ['right', 'left'];
      for (const side of sides) {
        const x0 = side === 'right' ? d.screen.x + 9 : d.screen.x - 9 - w;
        const box = { x0, y0: y - 11, x1: x0 + w, y1: y + 3 };
        if (!important(d) && !free(box)) continue;
        taken.push(box);
        labels.push(el('text', { x: side === 'right' ? d.screen.x + 9 : d.screen.x - 9, y, 'text-anchor': side === 'right' ? 'start' : 'end', class: 'label' + (sel || over ? ' sel' : '') }, text));
        break;
      }
    }
    this.marks.replaceChildren(...out, ...labels);
  }

  private selection() {
    const rv = this.rigView();
    const p = this.selLayer ? rv?.pieces[this.selLayer] : null;
    return p ? p.bbox : null;
  }

  private draw(refit = false) {
    void this.ready.then(() => {
      if (this.disposed) return;
      const entry = this.entry(), rig = this.rig(), pose = this.pose();
      if (!entry || !rig || !pose) { this.marks.replaceChildren(); return; }
      if (!this.loaded.has(entry.name)) { this.stage.setCharacter(entry.name, entry.data.imp); this.loaded.add(entry.name); }
      const shot = newShot('characters');
      const frame = () => ({ shot, actors: [{ id: 'c', rig, pose, unlocked: unlockedOf(rig), extra: false }], texts: [], layers: [] });
      this.stage.draw(frame(), null);
      if (refit || !this.fitted) {
        const b = this.stage.actor({ id: 'c', rig })?.bounds();
        // Keep the view on the paper (it starts at 0, 0), so no grey shows around the drawing.
        if (b) { this.stage.fit({ x: Math.max(0, b.x - b.w * 0.25), y: Math.max(0, b.y - b.h * 0.08), w: b.w * 1.5, h: b.h * 1.16 }, 0.92); this.fitted = true; }
        this.stage.draw(frame(), null);
      }
      this.stage.drawOverlay([], null, { w: 0, h: 0 }, this.trial ? null : this.selection());
      this.drawMarks();
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
      canvas.setPointerCapture(e.pointerId);
      const dot = this.trial ? null : this.dotAt(screen);
      const hit = this.stage.actor({ id: 'c', rig })?.hit(world) ?? null;
      if (this.adding) { this.addNode(world, hit?.bone ?? null); return; }
      if (dot && this.selLayer) { this.attach(this.selLayer, dot.node); return; }
      const sel = this.nodes().find((n) => n.id === this.selNode);
      if (!dot && sel?.parent && !rv.pivots[sel.id]) { this.place(sel.id, world); return; }
      if (dot) {
        const from = dot.node.parent ? rv.pivots[dot.node.id] : rv.rootPivot;
        this.drag = { kind: 'node', id: dot.node.id, from: { ...from }, moved: false, over: null };
        this.selNode = dot.node.id;
        this.note = '';
        this.render();
        this.draw();
        return;
      }
      if (hit) this.drag = { kind: 'part', start: screen, piece: hit.piece, bone: hit.bone };
    });
    canvas.addEventListener('pointermove', (e) => {
      const drag = this.drag, rig = this.rig(), rv = this.rigView();
      const screen = at(e), world = this.stage.screenToWorld(screen);
      if (!rig || !rv) return;
      if (!drag) {
        const over = this.trial ? null : this.dotAt(screen)?.node.id ?? null;
        if (over !== this.hover) { this.hover = over; this.drawMarks(); }
        canvas.style.cursor = this.adding || (this.selNode && !rv.pivots[this.selNode]) ? 'crosshair'
          : this.dotAt(screen) ? 'grab' : this.stage.actor({ id: 'c', rig })?.hit(world) ? 'pointer' : 'default';
        return;
      }
      if (drag.kind === 'node') {
        if (!drag.moved) { this.begin(); drag.moved = true; }
        const n = this.nodes().find((x) => x.id === drag.id)!;
        drag.over = this.dotAt(screen, drag.id)?.node.id ?? null;
        // The drawing stands at rest, so the stage point is the node's point.
        if (!n.parent) rv.rootPivot = world;
        else {
          rv.pivots[n.id] = world;
          const limb = LIMBS.find((l) => l.end === n.id);
          if (limb) rv.tips[limb.id] = { ...world };
        }
      } else if (drag.kind === 'part') {
        if (Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) < 4) return;
        // Dragging a part tries a bend around its own node (or the nearest one above it that bends).
        const skel = skeletonOf(rig), unlocked = unlockedOf(rig);
        let bone: BoneId = drag.bone, joint: JointId | null = null;
        while (bone !== skel.root && skel.jointOfBone[bone]) {
          const j = skel.jointOfBone[bone];
          if (canBend(rv, unlocked, j.id)) { joint = j.id; break; }
          bone = j.parent;
        }
        if (!joint) { this.drag = null; return; }
        this.trial ??= restPose(rv, this.view);
        this.drag = { kind: 'bend', joint, last: this.stage.screenToWorld(drag.start) };
        this.render();
        return;
      } else if (this.trial) {
        const skel = skeletonOf(rig), j = skel.joints.find((x) => x.id === drag.joint)!;
        const mats = boneMatrices(rv, this.trial, unlockedOf(rig), skel);
        const delta = swingAround(mats[j.parent], rv.pivots[j.id], drag.last, world);
        this.trial.angles[j.id] = clampToLimit((this.trial.angles[j.id] ?? 0) + delta, rig.limits[j.id]);
        drag.last = world;
      }
      this.draw();
    });
    const end = () => {
      const drag = this.drag, rv = this.rigView();
      if (!drag) return;
      this.drag = null;
      if (drag.kind === 'part') {
        // A click on a part picks its layer; then a click on a node attaches it.
        this.selLayer = this.selLayer === drag.piece ? null : drag.piece;
        this.trial = null;
        this.note = '';
        this.render();
      } else if (drag.kind === 'node' && drag.moved && rv) {
        const target = drag.over && this.nodes().find((n) => n.id === drag.over);
        if (target) {
          // Dropped on another node: put it back where it was and connect it instead.
          const n = this.nodes().find((x) => x.id === drag.id)!;
          if (!n.parent) rv.rootPivot = drag.from; else rv.pivots[n.id] = drag.from;
          this.undo.pop(); // the move is undone by the connect's own undo step
          this.connect(drag.id, target);
          this.render();
        } else this.changed();
      }
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

const round = (p: Pt): Pt => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
