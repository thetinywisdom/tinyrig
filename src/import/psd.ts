// PSD importer (Procreate). One canvas per view; each piece is a `_line`
// layer over a `_fill` layer, which map straight onto the two draw passes.
import { readPsd, type Layer } from 'ag-psd';
import { classifyName, GROUP_OR_PIECE, splitPsdLayerName, VIEWS, type ViewId } from '../model/skeleton';
import type { ImportResult, Issue, PieceRaster, Rect } from '../model/types';
import { buildMask, makeCanvas, splitPasses } from './raster';

interface Pair { line?: Layer; fill?: Layer; z: number }

function viewFromFileName(name: string): ViewId | null {
  const base = name.replace(/\.[^.]+$/, '').toLowerCase();
  return VIEWS.find((v) => new RegExp(`(^|[_\\-\\s])${v}$`).test(base)) ?? null;
}

function charFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_\-\s](front|side|back)$/i, '').replace(/^char[_-]/i, '') || 'character';
}

const rectOf = (l: Layer): Rect => ({
  x: l.left ?? 0, y: l.top ?? 0, w: (l.right ?? 0) - (l.left ?? 0), h: (l.bottom ?? 0) - (l.top ?? 0),
});

export async function importPsd(
  files: { name: string; data: ArrayBuffer }[], onProgress?: (done: number, total: number) => void,
): Promise<ImportResult> {
  const issues: Issue[] = [];
  const views = new Map<ViewId, Map<string, Pair>>();
  const unknown = new Set<string>(), hidden = new Set<string>();
  let charName: string | null = null, z = 0;

  for (const file of files) {
    const psd = readPsd(file.data, { skipCompositeImageData: true, skipThumbnail: true });
    const fileView = viewFromFileName(file.name);
    if (Math.max(psd.width, psd.height) < 2160) {
      issues.push({
        severity: 'warn',
        text: `${file.name} is ${psd.width} × ${psd.height} px. Draw at 2× the final size or more (2160 px+), or pieces go soft when the camera zooms in.`,
      });
    }
    // ag-psd lists layers bottom-first, the same order the pieces are drawn in.
    const walk = (layers: Layer[] | undefined, view: ViewId | null) => {
      for (const layer of layers ?? []) {
        const { base, pass } = splitPsdLayerName(layer.name ?? '');
        const c = classifyName(base);
        if (layer.children) {
          if (c.kind === 'char') { charName ??= c.name; walk(layer.children, view); }
          else if (c.kind === 'view') walk(layer.children, c.view);
          else walk(layer.children, view);
          continue;
        }
        if (!layer.canvas) continue; // empty layer
        if (c.kind === 'piece') {
          if (layer.hidden) hidden.add(layer.name!);
          const v = view ?? fileView ?? 'front';
          if (!views.has(v)) views.set(v, new Map());
          const pieces = views.get(v)!;
          if (!pieces.has(c.name)) pieces.set(c.name, { z: z++ });
          const pair = pieces.get(c.name)!;
          if (pass === 'line') pair.line ??= layer;
          else pair.fill ??= layer; // a piece with no suffix counts as fill
        } else if (c.kind === 'unknown' && !/^(background|layer)(_|$)/.test(c.name)) unknown.add(layer.name ?? '');
      }
    };
    walk(psd.children, null);
    charName ??= charFromFileName(file.name);
  }

  if (![...views.values()].some((v) => v.size)) {
    throw new Error('No pieces found. Name each piece layer like forearm_L_line and forearm_L_fill.');
  }

  const total = [...views.values()].reduce((n, v) => n + v.size, 0);
  let done = 0;
  const out: ImportResult['views'] = {};
  const noLine: string[] = [], noFill: string[] = [];

  for (const [view, pieces] of views) {
    const list: PieceRaster[] = [];
    for (const [name, pair] of pieces) {
      if (GROUP_OR_PIECE.has(name) && (pieces.has(`upper${name}`) || pieces.has(name.replace('leg', 'thigh')))) continue;
      const rects = [pair.line, pair.fill].filter(Boolean).map((l) => rectOf(l!));
      const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
      const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h));
      const bbox: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      const place = (layer?: Layer) => {
        const c = makeCanvas(bbox.w, bbox.h);
        if (layer?.canvas) {
          c.getContext('2d', { willReadFrequently: true })!.drawImage(layer.canvas, (layer.left ?? 0) - x0, (layer.top ?? 0) - y0);
        }
        return c;
      };
      const passes = splitPasses(place(pair.line), place(pair.fill), null);
      if (!pair.line) noLine.push(`${name} (${view})`);
      if (!pair.fill) noFill.push(`${name} (${view})`);
      list.push({
        name, view, bbox, scale: 1, z: pair.z,
        line: passes.line, fill: passes.fill, fillRaw: passes.fillRaw,
        mask: buildMask(passes.alpha, bbox.w, bbox.h, bbox, 1),
        hasStroke: passes.hasStroke, hasFill: passes.hasFill,
      });
      onProgress?.(++done, total);
      await new Promise((r) => setTimeout(r)); // let the progress bar paint
    }
    out[view] = list;
  }

  if (noLine.length) issues.push({ severity: 'warn', text: `No _line layer: ${noLine.join(', ')}. These pieces have no outline.` });
  if (noFill.length) issues.push({ severity: 'warn', text: `No _fill layer: ${noFill.join(', ')}. Other outlines will show through these pieces.` });
  if (hidden.size) issues.push({ severity: 'info', text: `Hidden layers were imported anyway: ${[...hidden].join(', ')}` });
  if (unknown.size) issues.push({ severity: 'warn', text: `Unknown layer names (ignored): ${[...unknown].join(', ')}` });

  return { name: charName ?? 'character', source: 'psd', fileNames: files.map((f) => f.name), views: out, issues, otherCharacters: [] };
}
