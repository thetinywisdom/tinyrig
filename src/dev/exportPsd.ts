// Development only: writes an imported view as a Procreate-style PSD
// (`<piece>_line` over `<piece>_fill`), so the PSD importer has a test file
// that matches the placeholder SVG exactly.
import { writePsd, type Layer } from 'ag-psd';
import type { ViewId } from '../model/skeleton';
import type { ImportResult } from '../model/types';

export function exportViewPsd(imp: ImportResult, view: ViewId): ArrayBuffer {
  const pieces = [...(imp.views[view] ?? [])].sort((a, b) => a.z - b.z);
  const s = pieces[0].scale;
  const x0 = Math.min(...pieces.map((p) => p.bbox.x)), y0 = Math.min(...pieces.map((p) => p.bbox.y));
  const pad = 200;
  const children: Layer[] = [];
  for (const p of pieces) {
    const left = Math.round((p.bbox.x - x0) * s) + pad, top = Math.round((p.bbox.y - y0) * s) + pad;
    children.push({ name: `${p.name}_fill`, left, top, canvas: p.fillRaw });
    children.push({ name: `${p.name}_line`, left, top, canvas: p.line });
  }
  // One canvas size for every view, at least 2x a 1080 frame.
  return writePsd({ width: 2400, height: 2200, children }, { generateThumbnail: false });
}
