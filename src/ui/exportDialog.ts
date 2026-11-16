// Export the episode: a small sheet with what will come out, MP4 or PNG frames, progress and Cancel.
import { exportEpisode, planEpisode } from '../export/episode';
import { canExportVideo } from '../export/video';
import { sizeLabel } from '../model/scene';
import { sizeOf } from '../model/storyboard';
import { slug, type Project } from '../project/project';
import { h } from './dom';
import { EASE_OUT, enter } from './motion';

function download(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

export function openExport(project: Project) {
  const sb = project.storyboard!, size = sizeOf(sb), plan = planEpisode(project);
  const animated = sb.panels.filter((p) => Object.values(p.lanes ?? {}).some((l) => l.poses.length) || p.images?.length).length;
  let cancelled = false, running = false;
  const body = h('div', { class: 'export-body' });
  const close = () => { if (running) { cancelled = true; return; } overlay.remove(); window.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const sheet = h('div', { class: 'export-sheet', role: 'dialog', 'aria-label': 'Export video' },
    h('div', { class: 'export-head' }, h('b', {}, 'Export video'), h('span', { class: 'grow' }), h('button', { class: 'icon-x', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'export-facts' },
      fact(String(sb.panels.length), sb.panels.length === 1 ? 'scene' : 'scenes'),
      fact(`${Math.round(plan.seconds * 10) / 10}`, 'sec'),
      fact(`${plan.width}×${plan.height}`, sizeLabel(size))),
    body);
  const overlay = h('div', { class: 'export' }, sheet);
  document.body.append(overlay);
  window.addEventListener('keydown', onKey);
  enter(sheet, 'translateY(8px) scale(0.98)', 200, EASE_OUT);

  const choose = () => {
    body.replaceChildren(
      h('p', { class: 'muted' }, animated < sb.panels.length
        ? `${sb.panels.length - animated} of ${sb.panels.length} scenes are not animated yet: they show their sketch for their length.`
        : 'Every scene is drawn through its camera. Only what is inside the frame is in the video.'),
      h('div', { class: 'export-actions' },
        h('button', { class: 'primary', id: 'export-mp4', disabled: !canExportVideo(), onclick: () => void run('mp4') }, 'Export MP4'),
        h('button', { id: 'export-png', onclick: () => void run('png') }, 'PNG frames (zip)')),
      ...(canExportVideo() ? [] : [h('p', { class: 'muted small' }, 'This browser cannot make video. Use Chrome or Edge, or export PNG frames.')]));
  };

  const run = async (kind: 'mp4' | 'png') => {
    running = true; cancelled = false;
    const bar = h('i', { class: 'export-fill' }), count = h('span', { class: 'px' }, `0 / ${plan.frames}`);
    body.replaceChildren(
      h('div', { class: 'export-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': plan.frames }, bar),
      h('div', { class: 'export-actions' }, count, h('span', { class: 'grow' }), h('button', { id: 'export-cancel', onclick: () => { cancelled = true; } }, 'Cancel')));
    try {
      const out = await exportEpisode(project, kind, {
        cancelled: () => cancelled,
        onProgress: (d, t) => { bar.style.width = `${(d / t) * 100}%`; count.textContent = `${d} / ${t} frames`; },
      });
      const name = `${slug(sb.name || 'episode')}${kind === 'mp4' ? '.mp4' : '_frames.zip'}`;
      download(name, out.bytes, kind === 'mp4' ? 'video/mp4' : 'application/zip');
      running = false;
      body.replaceChildren(
        h('p', { class: 'export-done', id: 'export-done' }, h('b', {}, name), h('span', { class: 'muted' }, ` · ${mb(out.bytes.length)}${out.result ? ` · ${out.result.video}` : ''}`)),
        ...(out.result?.note ? [h('p', { class: 'muted small' }, out.result.note)] : []),
        h('div', { class: 'export-actions' }, h('button', { onclick: choose }, 'Export again'), h('span', { class: 'grow' }), h('button', { class: 'primary', onclick: close }, 'Done')));
    } catch (err) {
      running = false;
      body.replaceChildren(
        h('p', { class: 'status error' }, err instanceof Error ? err.message : String(err)),
        h('div', { class: 'export-actions' }, h('button', { onclick: choose }, 'Back')));
    }
  };
  choose();
}

function fact(big: string, small: string) {
  return h('span', { class: 'export-fact' }, h('b', {}, big), h('span', { class: 'px muted' }, small));
}
