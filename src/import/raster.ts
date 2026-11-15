// Pixel helpers shared by the SVG and PSD importers.
import type { Mask, Pt, Rect } from '../model/types';

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const smoothstep = (lo: number, hi: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

export interface Passes {
  line: HTMLCanvasElement;
  fill: HTMLCanvasElement;
  fillRaw: HTMLCanvasElement;
  /** Coverage of the whole piece (0-255), same size as the canvases. */
  alpha: Uint8Array;
  hasStroke: boolean;
  hasFill: boolean;
}

/**
 * Turn "strokes only" and "fills only" renders of one piece into the two draw passes.
 *
 * A limb draws every piece's line image first and every fill image on top, so
 * each fill hides the other pieces' outlines at a joint. For a piece to still
 * show its own outline, its fill is cut away exactly where its own strokes are
 * visible. `vis` says which is on top in the original art (red = fill, blue =
 * stroke); strokes hidden under a later fill (a hairline under a hair shape)
 * are dropped rather than cut out.
 */
export function splitPasses(strokes: HTMLCanvasElement, fills: HTMLCanvasElement, vis: HTMLCanvasElement | null): Passes {
  const w = strokes.width, h = strokes.height;
  const sctx = strokes.getContext('2d', { willReadFrequently: true })!;
  const S = sctx.getImageData(0, 0, w, h);
  const G = fills.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
  const M = vis ? vis.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h) : null;
  const cut = new ImageData(new Uint8ClampedArray(G.data), w, h);
  const alpha = new Uint8Array(w * h);
  let strokePx = 0, fillPx = 0;

  for (let i = 0, p = 0; i < S.data.length; i += 4, p++) {
    let lineA = S.data[i + 3];
    if (M) {
      const r = M.data[i], b = M.data[i + 2];
      const share = r + b > 0 ? b / (r + b) : M.data[i + 3] > 0 ? 0 : 1;
      lineA *= Math.min(1, share * 2);
      S.data[i + 3] = lineA;
    }
    const fillA = G.data[i + 3];
    cut.data[i + 3] = fillA * (1 - smoothstep(0.5, 1, lineA / 255));
    alpha[p] = Math.max(lineA, fillA);
    if (lineA > 128) strokePx++;
    if (fillA > 128) fillPx++;
  }

  sctx.putImageData(S, 0, 0);
  const fill = makeCanvas(w, h);
  fill.getContext('2d')!.putImageData(cut, 0, 0);
  return { line: strokes, fill, fillRaw: fills, alpha, hasStroke: strokePx > 0, hasFill: fillPx > 0 };
}

/** Coarse inside/outside grid plus distance-to-edge, in stage units. */
export function buildMask(alpha: Uint8Array, pxW: number, pxH: number, bbox: Rect, scale: number): Mask {
  const step = Math.max(1, Math.max(bbox.w, bbox.h) / 400);
  const w = Math.max(1, Math.ceil(bbox.w / step)), h = Math.max(1, Math.ceil(bbox.h / step));
  const inside = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const py = Math.min(pxH - 1, Math.floor((j + 0.5) * step * scale));
    for (let i = 0; i < w; i++) {
      const px = Math.min(pxW - 1, Math.floor((i + 0.5) * step * scale));
      inside[j * w + i] = alpha[py * pxW + px] > 100 ? 1 : 0;
    }
  }
  // Two-pass chamfer distance. Anything beyond the grid counts as outside.
  const d = new Float32Array(w * h);
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : d[j * w + i]);
  const D = Math.SQRT2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    d[j * w + i] = inside[j * w + i]
      ? Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + D, at(i + 1, j - 1) + D)
      : 0;
  }
  for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) {
    if (!inside[j * w + i]) continue;
    d[j * w + i] = Math.min(d[j * w + i], at(i + 1, j) + 1, at(i, j + 1) + 1, at(i + 1, j + 1) + D, at(i - 1, j + 1) + D);
  }
  for (let k = 0; k < d.length; k++) d[k] *= step;
  return { x: bbox.x, y: bbox.y, step, w, h, inside, dist: d };
}

function cellIndex(m: Mask, p: Pt): number {
  const i = Math.floor((p.x - m.x) / m.step), j = Math.floor((p.y - m.y) / m.step);
  return i < 0 || j < 0 || i >= m.w || j >= m.h ? -1 : j * m.w + i;
}
export function maskHit(m: Mask, p: Pt): boolean {
  const k = cellIndex(m, p);
  return k >= 0 && m.inside[k] === 1;
}
export function maskDist(m: Mask, p: Pt): number {
  const k = cellIndex(m, p);
  return k >= 0 ? m.dist[k] : 0;
}

export function maskCentroid(m: Mask): Pt | null {
  let sx = 0, sy = 0, n = 0;
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
    if (m.inside[j * m.w + i]) { sx += i; sy += j; n++; }
  }
  return n ? { x: m.x + (sx / n + 0.5) * m.step, y: m.y + (sy / n + 0.5) * m.step } : null;
}

/** The inside point farthest from `from`. */
export function maskFarthest(m: Mask, from: Pt): Pt | null {
  let best = -1, out: Pt | null = null;
  for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
    if (!m.inside[j * m.w + i]) continue;
    const p = { x: m.x + (i + 0.5) * m.step, y: m.y + (j + 0.5) * m.step };
    const d = Math.hypot(p.x - from.x, p.y - from.y);
    if (d > best) { best = d; out = p; }
  }
  return out;
}

/**
 * Guess a pivot from two overlapping pieces whose round ends share a centre.
 * 'both': the point deepest inside both pieces (elbow, knee, wrist, ankle).
 * 'child': the centre of the child's round end where it tucks into the body
 *          (shoulder, hip), since the body's edge there is not round.
 */
export function guessPivot(child: Mask, parent: Mask, mode: 'child' | 'both'): Pt | null {
  const cells: { p: Pt; score: number }[] = [];
  let max = 0;
  for (let j = 0; j < child.h; j++) for (let i = 0; i < child.w; i++) {
    const k = j * child.w + i;
    if (!child.inside[k]) continue;
    const p = { x: child.x + (i + 0.5) * child.step, y: child.y + (j + 0.5) * child.step };
    if (!maskHit(parent, p)) continue;
    const score = mode === 'both' ? Math.min(child.dist[k], maskDist(parent, p)) : child.dist[k];
    cells.push({ p, score });
    if (score > max) max = score;
  }
  if (!cells.length) return null;
  const top = cells.filter((c) => c.score >= max * 0.92);
  if (mode === 'child') {
    // A straight limb has a whole ridge of equally deep points: take the end of the ridge.
    const centre = maskCentroid(child)!;
    let best = top[0], far = -1;
    for (const c of top) {
      const d = Math.hypot(c.p.x - centre.x, c.p.y - centre.y);
      if (d > far) { far = d; best = c; }
    }
    return best.p;
  }
  return {
    x: top.reduce((s, c) => s + c.p.x, 0) / top.length,
    y: top.reduce((s, c) => s + c.p.y, 0) / top.length,
  };
}
