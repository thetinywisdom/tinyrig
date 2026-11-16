// The whole storyboard as one video, in the project's size. Each scene is drawn through its camera, frame by
// frame; a scene not animated yet shows its sketch (or plain paper) for its length. Rendered locally.
import { cameraAt, compileScene } from '../model/scene';
import { FPS } from '../model/shot';
import { isActed, panelSeconds, sizeOf, type Panel } from '../model/storyboard';
import type { Project } from '../project/project';
import { StageView } from '../render/stage';
import { finishedFrame, prepareStage } from '../render/thumb';
import { exportMp4, exportPngSequence, type VideoResult } from './video';

/** H.264 wants even sides. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export interface EpisodePlan { width: number; height: number; frames: number; seconds: number; scenes: { panel: Panel; from: number; frames: number }[] }

export function planEpisode(project: Project): EpisodePlan {
  const sb = project.storyboard!, size = sizeOf(sb);
  let from = 0;
  const scenes = sb.panels.map((panel) => {
    const frames = Math.max(1, Math.round(panelSeconds(panel, project.shots) * FPS));
    const s = { panel, from, frames };
    from += frames;
    return s;
  });
  return { width: even(size.w), height: even(size.h), frames: from, seconds: from / FPS, scenes };
}

/** Draws any frame of the episode. Make one, use it, then dispose(). */
async function makeRenderer(project: Project, plan: EpisodePlan) {
  const sb = project.storyboard!, size = sizeOf(sb);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '180px', pointerEvents: 'none' });
  document.body.appendChild(host);
  const stage = new StageView();
  await stage.init(host);
  stage.app.ticker.stop();
  const loaded = new Set<string>();
  const format = { id: 'export', label: '', ratio: '', w: plan.width, h: plan.height };
  const paper = document.createElement('canvas');
  paper.width = plan.width; paper.height = plan.height;
  const sketches = new Map<string, HTMLImageElement | null>();
  let current: { panel: Panel; shot: ReturnType<typeof compileScene> } | null = null;

  const sketch = async (file: string) => {
    if (sketches.has(file)) return sketches.get(file)!;
    const bytes = project.assets.get(`sketches/${file}`);
    let img: HTMLImageElement | null = null;
    if (bytes) {
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
      img = new Image();
      try { await new Promise<void>((ok, bad) => { img!.onload = () => ok(); img!.onerror = () => bad(); img!.src = url; }); } catch { img = null; } finally { URL.revokeObjectURL(url); }
    }
    sketches.set(file, img);
    return img;
  };

  const render = async (frame: number): Promise<HTMLCanvasElement> => {
    const scene = plan.scenes.find((s) => frame >= s.from && frame < s.from + s.frames) ?? plan.scenes.at(-1)!;
    const p = scene.panel, f = frame - scene.from;
    if (!isActed(p)) {
      // Not animated yet: the sketch, fitted on white paper.
      const g = paper.getContext('2d')!;
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, paper.width, paper.height);
      const img = p.sketch ? await sketch(p.sketch) : null;
      if (img) {
        const k = Math.min(paper.width / img.naturalWidth, paper.height / img.naturalHeight);
        const w = img.naturalWidth * k, h = img.naturalHeight * k;
        g.drawImage(img, (paper.width - w) / 2, (paper.height - h) / 2, w, h);
      }
      return paper;
    }
    if (current?.panel !== p) {
      current = { panel: p, shot: compileScene(`export:${p.id}`, p, size, { minSeconds: scene.frames / FPS }) };
      await prepareStage(stage, project, current.shot, loaded);
    }
    const shot = current.shot;
    stage.draw(finishedFrame(project, shot, Math.min(shot.length - 1, f)), null);
    const cam = cameraAt(p, size, f / FPS);
    return stage.renderFrame(format, { x: cam.x, y: cam.y, width: cam.width }, 1);
  };

  return { render, dispose: () => { stage.destroy(); host.remove(); } };
}

export async function exportEpisode(project: Project, kind: 'mp4' | 'png', opts: { onProgress?: (done: number, total: number) => void; cancelled?: () => boolean }): Promise<{ bytes: Uint8Array; result?: VideoResult }> {
  const plan = planEpisode(project);
  const r = await makeRenderer(project, plan);
  try {
    if (kind === 'png') return { bytes: await exportPngSequence(plan.frames, r.render, opts.onProgress, opts.cancelled) };
    const result = await exportMp4({ width: plan.width, height: plan.height, frames: plan.frames, render: r.render, sound: null, onProgress: opts.onProgress, cancelled: opts.cancelled });
    return { bytes: result.bytes, result };
  } finally { r.dispose(); }
}
