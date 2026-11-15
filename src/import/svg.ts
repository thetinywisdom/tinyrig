// SVG importer (Illustrator, Figma, Affinity Designer, Penpot).
// Reads piece names, not folder nesting, then renders each piece to a line
// image and a fill image using the browser's own SVG engine.
import { classifyName, defaultPartOrder, GROUP_OR_PIECE, parsePartFileName, parseVariant, type ViewId } from '../model/skeleton';
import type { ImportResult, Issue, PieceRaster, Rect } from '../model/types';
import { buildMask, makeCanvas, splitPasses } from './raster';

/** Image pixels per SVG unit. 2 keeps outlines crisp when the camera zooms in. */
const RASTER_SCALE = 2;
const MAX_TEXTURE = 4096;

const RESOURCE_TAGS = new Set([
  'defs', 'style', 'symbol', 'lineargradient', 'radialgradient', 'pattern', 'clippath', 'mask', 'filter', 'marker',
]);
const SKIP_TAGS = new Set([...RESOURCE_TAGS, 'title', 'desc', 'metadata', 'script']);

interface Found { el: SVGGraphicsElement; z: number }
interface Scan {
  chars: Map<string, Map<ViewId, Map<string, Found>>>;
  issues: Issue[];
}

function nameOf(el: Element): string | null {
  // Newer Illustrator exports keep the real layer name in data-name when it had to change the id.
  return el.getAttribute('data-name') || el.getAttribute('id');
}

function containsPiece(el: Element): boolean {
  for (const d of el.querySelectorAll('[id], [data-name]')) {
    if (classifyName(nameOf(d)!).kind === 'piece') return true;
  }
  return false;
}

function scan(root: SVGSVGElement, fallbackName: string): Scan {
  const chars: Scan['chars'] = new Map();
  const issues: Issue[] = [];
  const unknown = new Set<string>(), dupes = new Set<string>();
  /** Variants drawn outside every view (a shared library layer) are offered in all views. */
  const shared: { char: string; name: string; el: Element }[] = [];
  let z = 0;

  const add = (char: string, view: ViewId, name: string, el: Element, quiet = false) => {
    if (!chars.has(char)) chars.set(char, new Map());
    const views = chars.get(char)!;
    if (!views.has(view)) views.set(view, new Map());
    const pieces = views.get(view)!;
    if (pieces.has(name)) { if (!quiet) dupes.add(`${name} (${view})`); } else pieces.set(name, { el: el as SVGGraphicsElement, z: z++ });
  };

  const walk = (el: Element, char: string | null, view: ViewId | null) => {
    for (const child of Array.from(el.children)) {
      if (SKIP_TAGS.has(child.localName.toLowerCase())) continue;
      const raw = nameOf(child);
      if (!raw) { walk(child, char, view); continue; }
      const c = classifyName(raw);
      if (c.kind === 'char') walk(child, c.name, view);
      else if (c.kind === 'view') walk(child, char, c.view);
      else if (c.kind === 'group') walk(child, char, view);
      else if (c.kind === 'piece') {
        if (GROUP_OR_PIECE.has(c.name) && containsPiece(child)) walk(child, char, view);
        else if (c.variant && !view) shared.push({ char: char ?? fallbackName, name: c.name, el: child });
        else add(char ?? fallbackName, view ?? 'front', c.name, child);
      } else {
        if (child.children.length) walk(child, char, view);
        // Apps auto-name unnamed objects (path123, Vector, Layer_1): only report names inside a character.
        if (char && !/^(path|rect|circle|ellipse|polygon|line|vector|group|layer|g|svg|clip|mask|artboard|frame)\w*$/.test(c.name)) {
          unknown.add(raw);
        }
      }
    }
  };
  walk(root, null, null);
  for (const v of shared) {
    const views = chars.get(v.char);
    if (!views?.size) add(v.char, 'front', v.name, v.el);
    else for (const view of [...views.keys()]) add(v.char, view, v.name, v.el, true);
  }

  if (unknown.size) issues.push({ severity: 'warn', text: `Unknown names (ignored): ${[...unknown].join(', ')}` });
  if (dupes.size) issues.push({ severity: 'warn', text: `Named twice, first one used: ${[...dupes].join(', ')}` });
  return { chars, issues };
}

// ---------------------------------------------------------------------------

function loadImage(svg: SVGSVGElement, w: number, h: number): Promise<HTMLCanvasElement> {
  const text = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = makeCanvas(w, h);
      canvas.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The browser could not render a piece of this SVG.')); };
    img.src = url;
  });
}

/** A copy of the SVG holding only one piece, its ancestors' transforms and shared resources. */
function isolate(root: SVGSVGElement, el: Element, box: Rect, pxW: number, pxH: number) {
  const chain: Element[] = [];
  for (let n: Element | null = el.parentElement; n && n !== root.parentElement; n = n.parentElement) chain.unshift(n);
  let outer: SVGSVGElement | null = null, cursor: Element | null = null;
  for (const ancestor of chain) {
    const copy = ancestor.cloneNode(false) as Element;
    for (const child of Array.from(ancestor.children)) {
      if (RESOURCE_TAGS.has(child.localName.toLowerCase())) copy.appendChild(child.cloneNode(true));
    }
    if (cursor) cursor.appendChild(copy); else outer = copy as SVGSVGElement;
    cursor = copy;
  }
  const piece = el.cloneNode(true) as SVGElement;
  cursor!.appendChild(piece);
  outer!.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  outer!.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  outer!.setAttribute('width', String(pxW));
  outer!.setAttribute('height', String(pxH));
  outer!.setAttribute('preserveAspectRatio', 'none');
  outer!.removeAttribute('style');
  outer!.removeAttribute('x');
  outer!.removeAttribute('y');
  return { svg: outer!, piece };
}

const SHAPE_SELECTOR = 'path, rect, circle, ellipse, line, polyline, polygon, text, tspan, use';

async function rasterize(root: SVGSVGElement, name: string, view: ViewId, found: Found): Promise<PieceRaster | null> {
  const el = found.el;
  const toRoot = root.getScreenCTM()!.inverse().multiply(el.getScreenCTM()!);
  const bb = el.getBBox();
  if (bb.width <= 0 && bb.height <= 0) return null;

  // What each shape paints, read from the live document so CSS classes and inheritance count.
  const live = [el, ...Array.from(el.querySelectorAll('*'))] as Element[];
  const paints = live.map((node) => {
    if (!node.matches(SHAPE_SELECTOR)) return null;
    const cs = getComputedStyle(node);
    const m = (node as SVGGraphicsElement).getScreenCTM?.();
    const unit = m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) : 1;
    const strokeW = cs.stroke !== 'none' ? (parseFloat(cs.strokeWidth) || 0) * unit : 0;
    return { fill: cs.fill !== 'none', stroke: strokeW > 0, strokeW };
  });
  const rootUnit = Math.sqrt(Math.abs((() => { const m = root.getScreenCTM()!; return m.a * m.d - m.b * m.c; })()));
  const maxStroke = Math.max(0, ...paints.map((p) => p?.strokeW ?? 0)) / rootUnit;
  const usesMask = live.some((n) => n.hasAttribute('mask') || n.localName === 'mask' || /mask\s*:/.test(n.getAttribute('style') ?? ''));

  const corners = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
    .map(([x, y]) => new DOMPoint(x, y).matrixTransform(toRoot));
  const pad = Math.ceil(maxStroke * 2) + 2; // room for stroke width and mitred corners
  const x0 = Math.floor(Math.min(...corners.map((c) => c.x)) - pad);
  const y0 = Math.floor(Math.min(...corners.map((c) => c.y)) - pad);
  const x1 = Math.ceil(Math.max(...corners.map((c) => c.x)) + pad);
  const y1 = Math.ceil(Math.max(...corners.map((c) => c.y)) + pad);
  const bbox: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const scale = Math.min(RASTER_SCALE, MAX_TEXTURE / Math.max(bbox.w, bbox.h));
  const pxW = Math.round(bbox.w * scale), pxH = Math.round(bbox.h * scale);

  const render = (mode: 'stroke' | 'fill' | 'vis') => {
    const { svg, piece } = isolate(root, el, bbox, pxW, pxH);
    const nodes = [piece, ...Array.from(piece.querySelectorAll('*'))] as SVGElement[];
    nodes.forEach((node, i) => {
      if (!node.style) return;
      const tag = node.localName.toLowerCase();
      if (tag === 'image') { if (mode !== 'fill') node.style.setProperty('display', 'none', 'important'); return; }
      if (mode === 'stroke') node.style.setProperty('fill', 'none', 'important');
      else if (mode === 'fill') node.style.setProperty('stroke', 'none', 'important');
      else {
        const p = paints[i];
        if (p) {
          node.style.setProperty('fill', p.fill ? '#ff0000' : 'none', 'important');
          node.style.setProperty('stroke', p.stroke ? '#0000ff' : 'none', 'important');
        }
        for (const prop of ['opacity', 'fill-opacity', 'stroke-opacity']) node.style.setProperty(prop, '1', 'important');
      }
    });
    return loadImage(svg, pxW, pxH);
  };

  const [strokes, fills, vis] = await Promise.all([render('stroke'), render('fill'), render('vis')]);
  const passes = splitPasses(strokes, fills, vis);
  return {
    name, view, bbox, scale, z: found.z,
    line: passes.line, fill: passes.fill, fillRaw: passes.fillRaw,
    mask: buildMask(passes.alpha, pxW, pxH, bbox, scale),
    hasStroke: passes.hasStroke, hasFill: passes.hasFill, usesMask,
  };
}

/** Parse an SVG and put it in the page, laid out but invisible, so bounding boxes and computed styles exist. */
function mountSvg(text: string, fileName: string): { root: SVGSVGElement; host: HTMLElement } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') {
    throw new Error(`${fileName} is not a readable SVG file.`);
  }
  const root = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
  if (!root.getAttribute('viewBox')) {
    const w = parseFloat(root.getAttribute('width') ?? ''), h = parseFloat(root.getAttribute('height') ?? '');
    if (w > 0 && h > 0) root.setAttribute('viewBox', `0 0 ${w} ${h}`);
  }
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
  host.appendChild(root);
  document.body.appendChild(host);
  return { root, host };
}

/**
 * Part-by-part import: one SVG per piece, named after the piece (head.svg, side_forearm_L.svg).
 * Each file must be exported with the whole artboard, so every part keeps its place.
 */
export async function importSvgParts(
  files: { name: string; text: string }[], onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const issues: Issue[] = [];
  const views: ImportResult['views'] = {};
  const unknown: string[] = [], dupes: string[] = [], noStroke: string[] = [], masked: string[] = [];
  const frames = new Set<string>(), seen = new Set<string>();
  let charName: string | null = null, done = 0;

  for (const file of files) {
    const parsed = parsePartFileName(file.name);
    onProgress?.(++done, files.length);
    if (!parsed.piece) { unknown.push(file.name); continue; }
    const view = parsed.view ?? 'front';
    if (seen.has(`${view}/${parsed.piece}`)) { dupes.push(file.name); continue; }
    seen.add(`${view}/${parsed.piece}`);
    charName ??= parsed.char;

    const { root, host } = mountSvg(file.text, file.name);
    try {
      frames.add(`${view}: ${(root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map((n) => Math.round(Number(n))).join(' ')}`);
      // The whole file is the piece: wrap its drawing in one group.
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      for (const child of Array.from(root.children)) {
        if (!RESOURCE_TAGS.has(child.localName.toLowerCase())) group.appendChild(child);
      }
      root.appendChild(group);
      const order = defaultPartOrder(view).indexOf(parsed.piece);
      const z = order < 0 ? 1000 + done : order; // variants go on top
      const r = await rasterize(root, parsed.piece, view, { el: group, z });
      if (!r) { issues.push({ severity: 'warn', text: `${file.name} is empty.` }); continue; }
      if (r.hasFill && !r.hasStroke && !parseVariant(parsed.piece)) noStroke.push(file.name);
      if (r.usesMask) masked.push(file.name);
      (views[view] ??= []).push(r);
    } finally {
      host.remove();
    }
  }

  if (!Object.keys(views).length) {
    throw new Error('No part files were recognised. Name each file after its piece, for example head.svg or forearm_L.svg.');
  }
  const perView = new Map<string, number>();
  for (const f of frames) perView.set(f.split(':')[0], (perView.get(f.split(':')[0]) ?? 0) + 1);
  if ([...perView.values()].some((n) => n > 1)) {
    issues.push({
      severity: 'error',
      text: 'The part files have different canvas sizes, so the parts were probably cropped on export and lost their positions. Export every part with the whole artboard (in Illustrator: tick Use Artboards) so each piece stays where it was drawn.',
    });
  }
  if (unknown.length) issues.push({ severity: 'warn', text: `File names not recognised (ignored): ${unknown.join(', ')}` });
  if (dupes.length) issues.push({ severity: 'warn', text: `Same piece twice, first one used: ${dupes.join(', ')}` });
  if (noStroke.length) issues.push({ severity: 'warn', text: `No live strokes, outlines may be expanded: ${noStroke.join(', ')}. Joints only stay seamless with live strokes.` });
  if (masked.length) issues.push({ severity: 'warn', text: `Uses masks: ${masked.join(', ')}. In Figma this means an inside or outside stroke; set every stroke to Center.` });
  issues.push({ severity: 'info', text: 'Separate files carry no layer order, so a standard order was used. Change it under Default draw order in the Rig tab.' });

  return { name: charName ?? 'character', source: 'svg', fileNames: files.map((f) => f.name), views, issues, otherCharacters: [] };
}

export async function importSvg(
  text: string, fileName: string, wanted?: string, onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const { root, host } = mountSvg(text, fileName);

  try {
    const fallback = fileName.replace(/\.[^.]+$/, '').replace(/^char[_-]/i, '') || 'character';
    const { chars, issues } = scan(root, fallback);
    if (!chars.size) {
      throw new Error(
        `No pieces found in ${fileName}. Pieces are found by name (head, chest, arm_L…). ` +
        'In Illustrator export with Object IDs: Layer Names; in Figma tick Include "id" attribute.',
      );
    }
    const name = wanted && chars.has(wanted) ? wanted : chars.keys().next().value!;
    const views = chars.get(name)!;
    const total = [...views.values()].reduce((n, v) => n + v.size, 0);
    let done = 0;

    const out: ImportResult['views'] = {};
    const noStroke: string[] = [], masked: string[] = [];
    for (const [view, pieces] of views) {
      const list: PieceRaster[] = [];
      for (const [pieceName, found] of pieces) {
        const r = await rasterize(root, pieceName, view, found);
        onProgress?.(++done, total);
        if (!r) { issues.push({ severity: 'warn', text: `${pieceName} (${view}) is empty.` }); continue; }
        if (r.hasFill && !r.hasStroke && !parseVariant(pieceName)) noStroke.push(`${pieceName} (${view})`);
        if (r.usesMask) masked.push(`${pieceName} (${view})`);
        list.push(r);
      }
      out[view] = list;
    }
    if (noStroke.length) {
      issues.push({
        severity: 'warn',
        text: `No live strokes, outlines may be expanded: ${noStroke.join(', ')}. Joints only stay seamless with live strokes.`,
      });
    }
    if (masked.length) {
      issues.push({
        severity: 'warn',
        text: `Uses masks: ${masked.join(', ')}. In Figma this means an inside or outside stroke; set every stroke to Center.`,
      });
    }
    return {
      name, source: 'svg', fileNames: [fileName], views: out, issues,
      otherCharacters: [...chars.keys()].filter((c) => c !== name),
    };
  } finally {
    host.remove();
  }
}
