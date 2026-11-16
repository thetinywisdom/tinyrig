// Match your layers: a stick figure of the rig with a drop spot on every body part. Parts the app could not place
// by name wait in the tray; drag each onto its spot (or click it, then the spot). One angle at a time.
// Drop a part on "New node" to give it a node of its own; drop it back on the tray to take it off.
import { applyKind, guessByPlace, refreshPoints } from '../import/build';
import {
  displayName, newNodeId, nodeForName, nodesOf, partSpots, RIG_KIND_LABEL, RIG_KINDS, rootNode, type RigKind,
} from '../model/rig';
import { VIEWS, VIEW_LABEL, type ViewId } from '../model/skeleton';
import type { ImportResult, PieceRaster, Pt, Rig } from '../model/types';
import { h } from './dom';

const SVG = 'http://www.w3.org/2000/svg';

/** The parts drawn in one angle (each name once). */
function layersIn(imp: ImportResult, rig: Rig, view: ViewId): { name: string; raster: PieceRaster }[] {
  const rv = rig.views[view];
  return (imp.views[view] ?? []).filter((p) => { const pc = rv?.pieces[p.name]; return pc && !pc.variant && !pc.shared; }).map((p) => ({ name: p.name, raster: p }));
}
const allLayers = (imp: ImportResult, rig: Rig) => VIEWS.flatMap((v) => layersIn(imp, rig, v).map((l) => ({ ...l, view: v })));

/** A part counts as placed when its name says where it goes, or someone attached it to a node. */
function placedIn(rig: Rig, imp: ImportResult, view: ViewId, name: string): boolean {
  const nodes = nodesOf(rig), root = rootNode(nodes).bone;
  if (nodeForName(nodes, name) || imp.onRoot?.includes(name)) return true;
  const bone = rig.views[view]?.pieces[name]?.bone;
  return !!bone && bone !== root;
}
export const unplacedLayers = (imp: ImportResult, rig: Rig) => allLayers(imp, rig).filter((l) => !placedIn(rig, imp, l.view, l.name));

function thumb(r: PieceRaster, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size * 2;
  const g = c.getContext('2d')!;
  const w = r.fill.width, hh = r.fill.height, k = Math.min((c.width - 6) / w, (c.height - 6) / hh);
  const x = (c.width - w * k) / 2, y = (c.height - hh * k) / 2;
  g.drawImage(r.fill, x, y, w * k, hh * k);
  g.drawImage(r.line, x, y, w * k, hh * k);
  c.className = 'mt-thumb';
  c.style.width = c.style.height = `${size}px`;
  return c;
}

export function mountMatcher(host: HTMLElement, imp: ImportResult, rig: Rig, onChange: () => void, start?: ViewId) {
  let picked: string | null = null;
  let view: ViewId = start && imp.views[start]?.length ? start : VIEWS.find((v) => imp.views[v]?.length) ?? 'front';
  /** Guesses you have moved or confirmed lose their question mark. */
  const confirmed = new Set<string>();

  /** Put a part on a node (in every angle that has it). `toTray` takes it off again. */
  const attach = (layer: string, nodeBone: string, toTray = false) => {
    confirmed.add(layer);
    rig.nodes ??= nodesOf(rig);
    for (const v of VIEWS) {
      const rv = rig.views[v];
      if (!rv) continue;
      for (const [name, p] of Object.entries(rv.pieces)) if (name === layer || (p.slot === layer && !p.overlay)) p.bone = nodeBone;
    }
    // The root (Hips, Body) is where unplaced parts wait too, so remember the ones you put there on purpose.
    const root = rootNode(rig.nodes).bone;
    imp.onRoot = (imp.onRoot ?? []).filter((n) => n !== layer);
    if (nodeBone === root && !toTray) imp.onRoot.push(layer);
    // Every node's point follows from the parts it now has.
    refreshPoints(rig, imp);
  };
  /** A node of its own, named after the part, moving with the root until you connect it in Rig. */
  const ownNode = (layer: string) => {
    rig.nodes ??= nodesOf(rig);
    const id = newNodeId(rig.nodes);
    rig.nodes.push({ id, bone: id, name: displayName(layer), parent: rootNode(rig.nodes).bone });
    attach(layer, id);
  };
  const done = () => { picked = null; onChange(); render(); };
  /** The app read a drawing as the wrong angle: move it (swapping with whatever is there). */
  const moveView = (from: ViewId, to: ViewId) => {
    if (from === to) return;
    const iv = imp.views as Record<string, unknown>, rv = rig.views as Record<string, unknown>;
    [iv[from], iv[to]] = [iv[to], iv[from]];
    [rv[from], rv[to]] = [rv[to], rv[from]];
    for (const o of [iv, rv]) for (const k of [from, to]) if (o[k] === undefined) delete o[k];
    view = to;
    refreshPoints(rig, imp);
    done();
  };

  const dropZone = (el: HTMLElement, onDrop: (layer: string) => void) => {
    el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/layer')) { e.preventDefault(); el.classList.add('over'); } });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget as Node)) el.classList.remove('over'); });
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); const l = e.dataTransfer?.getData('text/layer'); if (l) { onDrop(l); done(); } });
    el.addEventListener('click', () => { if (picked) { onDrop(picked); done(); } });
  };
  const tile = (l: { name: string; raster: PieceRaster }, size: number) => {
    const guess = imp.guessed?.includes(l.name) && !confirmed.has(l.name);
    const t = h('button', {
      class: 'mt-part' + (picked === l.name ? ' sel' : '') + (guess ? ' guess' : ''), draggable: true, 'data-match-layer': l.name,
      title: guess ? `${displayName(l.name)}: placed by where it sits. Drag it if it is wrong.` : `${displayName(l.name)}: drag it onto its body part`,
      // While placing another part, a click here goes to the spot this part sits in.
      onclick: (e: Event) => { if (picked && picked !== l.name) return; e.stopPropagation(); picked = picked === l.name ? null : l.name; render(); },
    }, thumb(l.raster, size), guess ? h('i', { class: 'mt-guess' }, '?') : null);
    t.addEventListener('dragstart', (e) => { e.dataTransfer!.setData('text/layer', l.name); e.dataTransfer!.effectAllowed = 'move'; t.classList.add('dragging'); });
    t.addEventListener('dragend', () => t.classList.remove('dragging'));
    return t;
  };

  function figure(kind: RigKind, onBone: (bone: string) => { name: string; raster: PieceRaster }[]): HTMLElement {
    const nodes = nodesOf(rig);
    if (kind === 'custom') {
      // Your own body type: no figure to follow, just your nodes. Drop a part on New node to make one.
      return h('div', { class: 'mt-grid' }, ...nodes.map((n) => {
        const here = onBone(n.bone);
        const spot = h('div', { class: 'mt-spot static' + (here.length ? ' full' : '') + (picked ? ' target' : ''), 'data-match-node': n.id }, h('span', { class: 'mt-name px' }, n.name), h('div', { class: 'mt-in' }, ...here.map((l) => tile(l, 30))));
        dropZone(spot, (layer) => attach(layer, n.bone));
        return spot;
      }));
    }
    const parts = partSpots(kind, view);
    const spotOf = (bone: string): Pt | null => parts[bone] ?? null;
    // Fit the figure in a box with room around it for the drop spots.
    const pts = Object.values(parts);
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x)), minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const pad = 0.08, w = maxX - minX + pad * 2, hgt = maxY - minY + pad * 2;
    const fx = (x: number) => ((x - minX + pad) / w) * 100, fy = (y: number) => ((y - minY + pad) / hgt) * 100;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'mt-stick'); svg.setAttribute('aria-hidden', 'true');
    const line = (a: Pt, b: Pt) => { const l = document.createElementNS(SVG, 'line'); l.setAttribute('x1', String(fx(a.x))); l.setAttribute('y1', String(fy(a.y))); l.setAttribute('x2', String(fx(b.x))); l.setAttribute('y2', String(fy(b.y))); svg.append(l); };
    const byBone = (bone: string | null) => nodes.find((n) => n.bone === bone);
    // The stick figure runs through the parts: each part joins the part it moves with.
    for (const n of nodes) {
      const a = spotOf(n.bone), p = byBone(n.parent);
      const b = p && spotOf(p.bone);
      if (a && b) line(b, a);
    }
    const head = spotOf('head');
    if (head) { const c = document.createElementNS(SVG, 'ellipse'); c.setAttribute('cx', String(fx(head.x))); c.setAttribute('cy', String(fy(head.y))); c.setAttribute('rx', '5.5'); c.setAttribute('ry', String(5.5 * (w / hgt))); svg.append(c); }
    const box = h('div', { class: 'mt-figure', style: `aspect-ratio:${(w * (kind === 'human' ? 0.95 : 1.35)) / hgt}` }, svg);
    for (const n of nodes) {
      const s = spotOf(n.bone);
      if (!s) continue;
      const here = onBone(n.bone);
      const spot = h('div', { class: 'mt-spot' + (here.length ? ' full' : '') + (picked ? ' target' : ''), 'data-match-node': n.id, style: `left:${fx(s.x)}%;top:${fy(s.y)}%`, title: n.name },
        h('span', { class: 'mt-name px' }, n.name), h('div', { class: 'mt-in' }, ...here.map((l) => tile(l, 30))));
      dropZone(spot, (layer) => attach(layer, n.bone));
      box.append(spot);
    }
    return box;
  }

  function render() {
    const parts = layersIn(imp, rig, view);
    const waiting = parts.filter((l) => !placedIn(rig, imp, view, l.name));
    const kind: RigKind = rig.nodes ? rig.kind ?? 'human' : 'human';
    const onBone = (bone: string) => parts.filter((l) => placedIn(rig, imp, view, l.name) && rig.views[view]?.pieces[l.name]?.bone === bone);
    const guesses = (imp.guessed ?? []).filter((n) => !confirmed.has(n) && parts.some((l) => l.name === n)).length;
    // Nodes with no spot on the figure (ones you made): listed under it.
    const spots = partSpots(kind);
    const own = nodesOf(rig).filter((n) => n.parent && !spots[n.bone]);
    const tray = h('div', { class: 'mt-tray' + (picked ? ' target' : ''), 'data-match-tray': '' },
      h('span', { class: 'px muted' }, waiting.length ? `${waiting.length} to place` : 'All placed'),
      h('div', { class: 'mt-tray-parts' }, ...waiting.map((l) => tile(l, 52))));
    dropZone(tray, (layer) => attach(layer, rootNode(nodesOf(rig)).bone, true));
    const fresh = h('div', { class: 'mt-new' + (picked ? ' target' : ''), 'data-match-node': 'new' }, h('span', { class: 'px' }, '+ New node'), h('span', { class: 'meta' }, 'for a part with no spot: a tail, a hat, a prop'));
    dropZone(fresh, ownNode);
    host.replaceChildren(
      h('div', { class: 'mt-head' },
        h('h3', {}, 'Match your layers'),
        h('span', { class: 'grow' }),
        h('span', { class: 'px muted' }, 'Body'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Body type' }, RIG_KINDS.map((k) => h('button', {
          class: kind === k ? 'selected' : '', 'data-match-kind': k, onclick: () => {
            applyKind(rig, imp, k, 'high'); imp.onRoot = [];
            // A humanoid gets its parts placed by where they sit again; other bodies match by name, or by hand.
            if (k === 'human' && unplacedLayers(imp, rig).length) guessByPlace(rig, imp);
            refreshPoints(rig, imp); confirmed.clear(); done();
          },
        }, RIG_KIND_LABEL[k])))),
      h('div', { class: 'mt-head' },
        h('span', { class: 'px muted' }, 'Profile'),
        h('div', { class: 'seg', role: 'group', 'aria-label': 'Profile' }, VIEWS.map((v) => h('button', {
          class: v === view ? 'selected' : '', 'data-match-view': v, disabled: !imp.views[v]?.length,
          title: imp.views[v]?.length ? `${VIEW_LABEL[v]} drawing` : `No ${VIEW_LABEL[v]} drawing in these files`,
          onclick: () => { view = v; picked = null; render(); },
        }, VIEW_LABEL[v]))),
        h('span', { class: 'grow' }),
        h('label', { class: 'mt-is' }, h('span', { class: 'px muted' }, 'This drawing is'),
          h('select', { id: 'match-is', onchange: (e: Event) => moveView(view, (e.target as HTMLSelectElement).value as ViewId) },
            VIEWS.map((v) => h('option', { value: v, selected: v === view }, VIEW_LABEL[v]))))),
      h('p', { class: 'meta' }, waiting.length
        ? 'Drag each part onto where it belongs on the figure. (Or click a part, then a spot.)'
        : guesses ? `The parts marked ? were placed by where they sit in your drawing. Drag any that are wrong.` : 'Drag any part to another spot to change it.'),
      h('div', { class: 'mt-body' },
        h('div', { class: 'mt-left' }, tray, fresh, own.length ? h('div', { class: 'mt-own' }, ...own.map((n) => {
          const spot = h('div', { class: 'mt-spot static' + (picked ? ' target' : ''), 'data-match-node': n.id }, h('span', { class: 'mt-name px' }, n.name), h('div', { class: 'mt-in' }, ...onBone(n.bone).map((l) => tile(l, 30))));
          dropZone(spot, (layer) => attach(layer, n.bone));
          return spot;
        })) : null),
        figure(kind, onBone)));
  }
  render();
}
