// Inside a scene. The header says where you are and what you are doing:
//   ▦ Episode / 03 Momo finds the cat ▾ / ( Rig 2 | ● Animate 6 poses · 4 keys )        3.5s ● saved  ▶ Play scene
// Rig: who is in the scene and how they bend here. Animate: their poses, the images and the camera.
import { addCast, sceneSeconds, sizeLabel, stackOf, type ProjectSize } from '../model/scene';
import { sizeOf, type Panel } from '../model/storyboard';
import type { Rig } from '../model/types';
import type { Project } from '../project/project';
import { pictures } from '../render/thumb';
import { AnimateView } from './animate';
import { CharactersView } from './characters';
import { h } from './dom';

export type SceneTab = 'rig' | 'animate';

export interface SceneContext {
  project: Project;
  panel: Panel;
  tab: SceneTab;
  onChanged: () => void;
  back: () => void;
  open: (panel: Panel, tab: SceneTab) => void;
  importCharacter: () => void;
  saveState: () => string;
}

const ICON_GRID = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/></svg>';

export class SceneView {
  private root = h('div', { class: 'scene' });
  private head = h('header', { class: 'scene-head' });
  private body = h('div', { class: 'scene-body' });
  private tabView: { dispose(): void } | null = null;
  private animate: AnimateView | null = null;

  constructor(host: HTMLElement, private ctx: SceneContext) {
    this.root.append(this.head, this.body);
    host.replaceChildren(this.root);
    this.show(ctx.tab);
  }

  private get p() { return this.ctx.panel; }
  private size(): ProjectSize { return sizeOf(this.ctx.project.storyboard!); }
  private number() { return this.ctx.project.storyboard!.panels.indexOf(this.p) + 1; }
  rigOf(character: string): Rig | null {
    return this.p.rigs?.[character] ?? this.ctx.project.characters.find((c) => c.name === character)?.data.rig ?? null;
  }
  private changed = () => { pictures.forget(''); this.ctx.onChanged(); this.renderHead(); };

  private show(tab: SceneTab) {
    this.tabView?.dispose();
    this.animate = null;
    this.ctx.tab = tab;
    const host = h('div', { class: 'scene-tab' });
    this.body.replaceChildren(host);
    if (tab === 'rig') {
      this.tabView = new CharactersView(host, {
        project: this.ctx.project, onChanged: this.changed, back: this.ctx.back, importCharacter: this.ctx.importCharacter,
        show: this.p.cast?.[0]?.character,
        scene: {
          panel: this.p,
          addCast: (name) => { const rig = this.rigOf(name); if (rig) { addCast(this.p, name, rig, this.size()); this.changed(); } },
          removeCast: (name) => {
            const gone = new Set((this.p.cast ?? []).filter((c) => c.character === name).map((c) => c.id));
            this.p.cast = (this.p.cast ?? []).filter((c) => !gone.has(c.id));
            for (const id of gone) delete this.p.lanes?.[id];
            this.p.stack = this.p.stack?.filter((e) => !(e.kind === 'cast' && gone.has(e.id)));
            if (this.p.rigs) delete this.p.rigs[name];
            this.changed();
            this.show('rig');
          },
        },
      });
      if (import.meta.env.DEV) Object.assign(window, { __chars: this.tabView, __anim: null });
    } else {
      const view = new AnimateView(host, {
        project: this.ctx.project, panel: this.p, size: () => this.size(), rigOf: (n) => this.rigOf(n),
        onChanged: this.changed, toRig: () => this.ctx.open(this.p, 'rig'),
      });
      view.onPlayChange = () => this.renderHead();
      this.animate = view;
      this.tabView = view;
      if (import.meta.env.DEV) Object.assign(window, { __anim: view, __chars: null });
    }
    this.renderHead();
  }

  private renderHead() {
    const sb = this.ctx.project.storyboard!;
    const poses = Object.values(this.p.lanes ?? {}).reduce((n, l) => n + l.poses.length, 0);
    const keys = this.p.camera?.length ?? 0, cast = new Set((this.p.cast ?? []).map((c) => c.character)).size;
    const line = this.p.notes.split('\n')[0] || 'Untitled scene';
    const crumb = (el: HTMLElement) => el;
    const grid = h('span', { class: 'crumb-icon' });
    grid.innerHTML = ICON_GRID;
    const playing = this.animate?.isPlaying ?? false;
    const tabs: { id: SceneTab; label: string; count: string }[] = [
      { id: 'rig', label: 'Rig', count: String(cast) },
      { id: 'animate', label: 'Animate', count: `${poses} ${poses === 1 ? 'pose' : 'poses'} · ${keys} ${keys === 1 ? 'key' : 'keys'}` },
    ];
    this.head.replaceChildren(
      crumb(h('button', { class: 'crumb dim', id: 'scene-back', onclick: () => this.ctx.back(), title: 'Back to the storyboard' }, grid, sb.name || 'Storyboard')),
      h('span', { class: 'slash' }, '/'),
      h('details', { class: 'menu crumb-menu' },
        h('summary', { class: 'crumb', id: 'scene-pick' }, h('span', { class: 'snum' }, String(this.number()).padStart(2, '0')), h('span', { class: 'crumb-name' }, line), h('span', { class: 'caret' }, '▾')),
        h('div', { class: 'menu-items' }, sb.panels.map((p, i) => h('button', {
          class: p === this.p ? 'selected' : '', onclick: () => this.ctx.open(p, this.ctx.tab),
        }, h('span', { class: 'snum' }, String(i + 1).padStart(2, '0')), ' ', p.notes.split('\n')[0] || 'Untitled scene')))),
      h('span', { class: 'slash' }, '/'),
      h('div', { class: 'switch', role: 'tablist', 'aria-label': 'Work on' }, tabs.map((t) => h('button', {
        role: 'tab', 'aria-selected': String(this.ctx.tab === t.id), class: this.ctx.tab === t.id ? 'on' : '', 'data-tab': t.id,
        onclick: () => { if (this.ctx.tab !== t.id) this.show(t.id); },
      }, t.label, h('small', {}, t.count)))),
      h('span', { class: 'grow' }),
      h('span', { class: 'px muted' }, `${Math.round(sceneSeconds(this.p) * 10) / 10}s · ${sizeLabel(this.size())}`),
      h('span', { class: 'px save-led', id: 'save-state' }, this.ctx.saveState()),
      h('button', {
        class: 'play', id: 'scene-play', disabled: sceneSeconds(this.p) <= 0 || !stackOf(this.p).length,
        onclick: () => { if (this.ctx.tab !== 'animate') this.show('animate'); this.animate?.play(); },
      }, playing ? '■ Stop' : '▶ Play scene'),
    );
  }

  dispose() { this.tabView?.dispose(); }
}
