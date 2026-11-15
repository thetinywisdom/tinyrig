// The filmstrip: every panel of the scene in a row along the top of the editor. The current shot is
// marked; clicking another opens it. Sketch-only panels show their sketch and open as a new shot.
import { panelSeconds } from '../model/storyboard';
import { pictures } from '../render/thumb';
import { h } from './dom';
import type { Editor } from './editor';

/** Object URLs for sketches, kept while their bytes stay the same. */
const sketchUrls = new Map<string, { bytes: Uint8Array; url: string }>();
function sketchUrl(ed: Editor, file: string): string | null {
  const bytes = ed.project.assets.get(`sketches/${file}`);
  if (!bytes) return null;
  const hit = sketchUrls.get(file);
  if (hit?.bytes === bytes) return hit.url;
  if (hit) URL.revokeObjectURL(hit.url);
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], /\.svg$/i.test(file) ? { type: 'image/svg+xml' } : {}));
  sketchUrls.set(file, { bytes, url });
  return url;
}

export function renderFilmstrip(ed: Editor): HTMLElement {
  const sb = ed.project.storyboard, { project } = ed;
  const strip = h('nav', { class: 'filmstrip', 'aria-label': 'Shots in this scene' });
  if (!sb) return strip;
  sb.panels.forEach((p, i) => {
    const shot = p.shot ? project.shots.find((s) => s.name === p.shot) : undefined;
    const current = shot === ed.shot;
    const img = h('img', { alt: '', draggable: false });
    if (shot?.actors.length && !(sb.showSketches && p.sketch)) {
      // This shot's own picture is drawn from the editor's state when it changes; others come from the shared cache.
      const cached = pictures.cached(shot);
      if (cached) img.src = cached;
      else void pictures.picture(project, shot, 192).then((url) => { img.src = url; }).catch(() => undefined);
    } else if (p.sketch) {
      const url = sketchUrl(ed, p.sketch);
      if (url) img.src = url;
    }
    strip.append(h('button', {
      class: 'film' + (current ? ' current' : '') + (img.src ? '' : ' blank'), 'aria-current': current ? 'true' : undefined,
      title: `Shot ${i + 1} · ${panelSeconds(p, project.shots)}s${p.notes ? `\n${p.notes}` : ''}`, 'data-panel': p.id,
      onclick: () => { if (!current) ed.ctx.openPanel(p); },
    }, img, h('span', { class: 'film-n' }, String(i + 1))));
  });
  return strip;
}
