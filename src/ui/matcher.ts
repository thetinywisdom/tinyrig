// Match your layers: after an import, every layer the app could not place by its name waits on the left; the
// rig's nodes wait on the right. Drag a layer onto the node that moves it, or onto "New node" to give it a node
// of its own. Clicking a layer and then a node does the same, without dragging.
import { applyKind, guessNodePoint } from '../import/build';
import { displayName, newNodeId, nodeForName, nodesOf, RIG_KIND_LABEL, RIG_KINDS, rootNode, skeletonOf, type RigKind } from '../model/rig';
import { VIEWS } from '../model/skeleton';
import type { ImportResult, PieceRaster, Rig } from '../model/types';
import { h } from './dom';

/** The layers of a character: one entry per name, with a picture from the first angle that has it. */
function layersOf(imp: ImportResult, rig: Rig): { name: string; raster: PieceRaster }[] {
  const seen = new Map<string, PieceRaster>();
  for (const v of VIEWS) {
    for (const p of imp.views[v] ?? []) {
      const piece = rig.views[v]?.pieces[p.name];
      if (!piece || piece.variant || piece.shared || seen.has(p.name)) continue;
      seen.set(p.name, p);
    }
  }
  return [...seen].map(([name, raster]) => ({ name, raster }));
}

/** A layer counts as placed when its name says where it goes, or someone attached it to a node. */
function placed(rig: Rig, name: string): boolean {
  const nodes = nodesOf(rig), root = rootNode(nodes).bone;
  if (nodeForName(nodes, name)) return true;
  const bone = VIEWS.map((v) => rig.views[v]?.pieces[name]?.bone).find(Boolean);
  return !!bone && bone !== root;
}
export const unplacedLayers = (imp: ImportResult, rig: Rig) => layersOf(imp, rig).filter((l) => !placed(rig, l.name));

function thumb(r: PieceRaster): HTMLCanvasElement {
  const size = 64, c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const g = c.getContext('2d')!;
  const w = r.fill.width, hh = r.fill.height, k = Math.min((c.width - 8) / w, (c.height - 8) / hh);
  const x = (c.width - w * k) / 2, y = (c.height - hh * k) / 2;
  g.drawImage(r.fill, x, y, w * k, hh * k);
  g.drawImage(r.line, x, y, w * k, hh * k);
  c.className = 'mt-thumb';
  return c;
}

export function mountMatcher(host: HTMLElement, imp: ImportResult, rig: Rig, onChange: () => void) {
  let picked: string | null = null;
  /** Guesses you have moved or confirmed lose their question mark. */
  const confirmed = new Set<string>();
  const attach = (layer: string, nodeBone: string) => {
    confirmed.add(layer);
    rig.nodes ??= nodesOf(rig);
    for (const v of VIEWS) {
      const rv = rig.views[v];
      if (!rv) continue;
      for (const [name, p] of Object.entries(rv.pieces)) if (name === layer || (p.slot === layer && !p.overlay)) p.bone = nodeBone;
    }
    // A node that had no layer gets its point from this one.
    const node = rig.nodes.find((n) => n.bone === nodeBone);
    if (node?.parent) for (const v of VIEWS) { const at = rig.views[v] && guessNodePoint(rig, imp, v, node.id); if (at) rig.views[v]!.pivots[node.id] = at; }
  };
  /** A node of its own, named after the layer, moving with the root until you connect it in Rig. */
  const ownNode = (layer: string) => {
    rig.nodes ??= nodesOf(rig);
    const id = newNodeId(rig.nodes);
    rig.nodes.push({ id, bone: id, name: displayName(layer), parent: rootNode(rig.nodes).bone });
    attach(layer, id);
  };
  const done = () => { picked = null; onChange(); render(); };

  const dropZone = (el: HTMLElement, onDrop: (layer: string) => void) => {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/layer')) { e.preventDefault(); el.classList.add('over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); const l = e.dataTransfer?.getData('text/layer'); if (l) { onDrop(l); done(); } });
    el.addEventListener('click', () => { if (picked) { onDrop(picked); done(); } });
  };
  const tile = (l: { name: string; raster: PieceRaster }) => {
    const t = h('button', { class: 'mt-layer' + (picked === l.name ? ' sel' : ''), draggable: true, 'data-match-layer': l.name, title: 'Drag onto the node that moves it',
      // While placing another layer, a click here goes to the slot this tile sits in.
      onclick: (e: Event) => { if (picked && picked !== l.name) return; e.stopPropagation(); picked = picked === l.name ? null : l.name; render(); } },
    thumb(l.raster), h('span', {}, displayName(l.name)), imp.guessed?.includes(l.name) && !confirmed.has(l.name) ? h('i', { class: 'mt-guess', title: 'Placed by where it sits. Drag it if it is wrong.' }, '?') : null);
    t.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('text/layer', l.name); e.dataTransfer!.effectAllowed = 'move'; t.classList.add('dragging'); });
    t.addEventListener('dragend', () => t.classList.remove('dragging'));
    return t;
  };

  function render() {
    const all = layersOf(imp, rig), waiting = all.filter((l) => !placed(rig, l.name));
    const nodes = nodesOf(rig), root = rootNode(nodes);
    const order = [root, ...skeletonOf({ nodes }).joints.map((j) => nodes.find((n) => n.id === j.id)!)];
    const kind: RigKind = rig.nodes ? rig.kind ?? 'human' : 'human';
    const guesses = (imp.guessed ?? []).filter((n) => !confirmed.has(n)).length;
    const onNode = (bone: string) => all.filter((l) => placed(rig, l.name) && VIEWS.some((v) => rig.views[v]?.pieces[l.name]?.bone === bone));
    host.replaceChildren(
      h('div', { class: 'mt-head' },
        h('h3', {}, waiting.length ? `Match your layers · ${waiting.length} to place` : guesses ? `Match your layers · ${guesses} placed by where they sit` : 'Every layer is placed'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Rig' }, RIG_KINDS.map((k) => h('button', {
          class: kind === k ? 'selected' : '', 'data-match-kind': k,
          onclick: () => { applyKind(rig, imp, k, 'high'); done(); },
        }, RIG_KIND_LABEL[k])))),
      h('p', { class: 'meta' }, waiting.length
        ? 'These layers have names the app could not place. Drag each onto the node that moves it, or onto New node to give it one of its own. (Or click a layer, then a node.)'
        : guesses ? 'Parts marked ? were placed by where they sit in your drawing. Drag any that are wrong onto the right node.' : 'Drag any layer to another node to change it.'),
      h('div', { class: 'mt-body' },
        h('div', { class: 'mt-waiting' + (picked ? ' picking' : '') }, ...(waiting.length ? waiting.map(tile) : [h('p', { class: 'meta' }, 'Nothing left to place.')])),
        h('div', { class: 'mt-nodes' }, ...order.map((n) => {
          const slot = h('div', { class: 'mt-slot' + (picked ? ' target' : ''), 'data-match-node': n.id },
            h('span', { class: 'px' }, n.name), h('div', { class: 'mt-on' }, ...onNode(n.bone).map(tile)));
          dropZone(slot, (layer) => attach(layer, n.bone));
          return slot;
        }), (() => {
          const fresh = h('div', { class: 'mt-slot mt-new' + (picked ? ' target' : ''), 'data-match-node': 'new' }, h('span', { class: 'px' }, '+ New node'), h('span', { class: 'meta' }, 'its own node, named after the layer'));
          dropZone(fresh, ownNode);
          return fresh;
        })())));
  }
  render();
}
