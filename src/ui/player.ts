// Play the whole scene: every panel in turn — the animated shot where there is one, the sketch where there
// is not — with the scene's sound running straight across the cuts. Opens over the app; Esc or Close ends it.
import { AudioEngine } from '../audio/audio';
import { formatById, FPS, type Shot } from '../model/shot';
import { formatRuntime, panelAt, sceneClips, sceneFrames } from '../model/storyboard';
import type { Project } from '../project/project';
import { StageView } from '../render/stage';
import { finishedFrame, prepareStage } from '../render/thumb';
import { h } from './dom';
import { EASE_OUT, enter } from './motion';

export interface PlayerResult { lastFrame: number; panelsShown: string[] }

export async function playScene(project: Project, from: number, onClose: (result: PlayerResult) => void) {
  const sb = project.storyboard;
  if (!sb?.panels.length) return;
  const total = sceneFrames(sb, project.shots);
  const format = formatById('yt');
  const vw = Math.min(window.innerWidth * 0.92, ((window.innerHeight - 120) * format.w) / format.h);
  const host = h('div', { class: 'player-stage', style: `width:${Math.round(vw)}px;height:${Math.round((vw * format.h) / format.w)}px` });
  const sketch = h('img', { class: 'player-sketch', alt: '', hidden: true });
  const caption = h('span', { class: 'player-time', id: 'player-time' }, '');
  const status = h('p', { class: 'player-status', role: 'status' }, 'Getting the scene ready…');
  const close = h('button', { id: 'player-close' }, 'Close');
  const root = h('div', { class: 'player', role: 'dialog', 'aria-label': 'Playing the scene' },
    h('div', { class: 'player-frame' }, host, sketch),
    h('div', { class: 'player-bar' }, caption, status, h('span', { class: 'grow' }), close));
  document.body.appendChild(root);
  enter(root.firstElementChild as HTMLElement, 'scale(0.98)', 200, EASE_OUT);

  const stage = new StageView(), audio = new AudioEngine(), loaded = new Set<string>();
  const urls = new Map<string, string>();
  let raf = 0, done = false, frame = from;
  const shown: string[] = [];
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    audio.stop();
    window.removeEventListener('keydown', onKey, true);
    stage.destroy();
    for (const u of urls.values()) URL.revokeObjectURL(u);
    root.remove();
    onClose({ lastFrame: frame, panelsShown: shown });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.code === 'Space') { e.preventDefault(); e.stopPropagation(); finish(); }
  };
  window.addEventListener('keydown', onKey, true);
  close.addEventListener('click', finish);

  // Everything is loaded before playing, so no shot stalls at its cut.
  await stage.init(host);
  if (done) return;
  stage.app.canvas.style.display = 'block';
  for (const shot of project.shots) await prepareStage(stage, project, shot, loaded);
  for (const c of sb.sound ?? []) {
    const bytes = project.assets.get(`audio/${c.file}`);
    if (bytes) await audio.load(c.file, bytes).catch(() => undefined);
  }
  for (const p of sb.panels) {
    const bytes = p.sketch && project.assets.get(`sketches/${p.sketch}`);
    if (bytes) urls.set(p.id, URL.createObjectURL(new Blob([bytes as unknown as BlobPart], /\.svg$/i.test(p.sketch!) ? { type: 'image/svg+xml' } : {})));
  }
  if (done) return;
  status.textContent = '';

  const shotOf = (name?: string) => (name ? project.shots.find((s) => s.name === name) : undefined);
  let lastPanel = '';
  const show = (f: number) => {
    const hit = panelAt(sb, project.shots, f);
    if (!hit) return;
    const { panel, start } = hit, shot: Shot | undefined = shotOf(panel.shot);
    const animated = !!shot?.actors.length || !!shot?.backgrounds.length;
    if (panel.id !== lastPanel) {
      lastPanel = panel.id;
      shown.push(panel.id);
      sketch.hidden = animated;
      host.style.visibility = animated ? 'visible' : 'hidden';
      if (!animated) { const u = urls.get(panel.id); if (u) sketch.src = u; else sketch.removeAttribute('src'); }
    }
    if (animated && shot) {
      const camera = shot.cameras.yt, r = { x: camera.x - camera.width / 2, y: camera.y - (camera.width * format.h) / format.w / 2, w: camera.width, h: (camera.width * format.h) / format.w };
      stage.fit(r, 1);
      stage.draw(finishedFrame(project, shot, Math.min(shot.length - 1, f - start), { subtitles: true }), { format, camera });
      stage.clearOverlay();
    }
    const n = sb.panels.indexOf(panel) + 1;
    caption.textContent = `Shot ${n} of ${sb.panels.length} · ${formatRuntime(f / FPS)} / ${formatRuntime(total / FPS)}`;
    caption.dataset.panel = panel.id;
    caption.dataset.frame = String(f);
  };

  // The clock is the sound's own clock, so picture and sound never drift apart.
  const clips = sceneClips(sb, project.shots);
  audio.play(clips, from);
  const t0 = audio.now();
  const tick = () => {
    if (done) return;
    frame = from + Math.floor((audio.now() - t0) * FPS);
    if (frame >= total) { frame = total - 1; show(frame); finish(); return; }
    show(frame);
    raf = requestAnimationFrame(tick);
  };
  show(from);
  raf = requestAnimationFrame(tick);
}
