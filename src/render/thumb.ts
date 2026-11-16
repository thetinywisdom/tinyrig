// Pictures of shots: one frame, drawn by the same renderer the editor and export use.
// One hidden stage serves the whole app (storyboard panels, the editor's filmstrip, the scene player's
// stills), and pictures are cached until their shot changes.
import type { Project } from '../project/project';
import type { Rig } from '../model/types';
import { evaluate, formatById, stackOrder, visibleLayers, visibleTexts, type Camera, type FormatDef, type Shot } from '../model/shot';
import { unlockedOf } from '../model/rig';
import { StageView, type DrawActor, type SceneFrame } from './stage';

/**
 * Everything the renderer needs for one finished frame of a shot: characters posed by the timeline,
 * image layers showing at that frame, the stack order. Hidden layers and characters are left out.
 */
export function finishedFrame(project: Project, shot: Shot, frame: number, opts: { subtitles?: boolean } = {}): SceneFrame {
  const actors: DrawActor[] = [];
  for (const a of shot.actors) {
    if (a.hidden) continue;
    const entry = project.characters.find((c) => c.name === a.character);
    if (!entry) continue;
    // A scene may have tweaked this character's rig for itself.
    const rig = (shot as Shot & { rigs?: Record<string, Rig> }).rigs?.[a.character] ?? entry.data.rig;
    const pose = evaluate(shot, a, frame);
    if (rig.views[pose.view]) actors.push({ id: a.id, rig, pose, unlocked: unlockedOf(rig), extra: a.role === 'extra' });
  }
  return {
    shot, actors, order: stackOrder(shot),
    layers: visibleLayers(shot, frame).filter((l) => !l.hidden),
    texts: visibleTexts(shot, frame).filter((t) => t.kind === 'text' || opts.subtitles),
  };
}

/** Give a stage the art and images a shot needs. */
export async function prepareStage(stage: StageView, project: Project, shot: Shot, loaded: Set<string>) {
  for (const a of shot.actors) {
    const entry = project.characters.find((c) => c.name === a.character);
    if (entry && !loaded.has(entry.name)) { stage.setCharacter(entry.name, entry.data.imp); loaded.add(entry.name); }
  }
  for (const l of shot.backgrounds) {
    const bytes = project.assets.get(`backgrounds/${l.file}`);
    if (bytes) await stage.setBackground(l.file, bytes).catch(() => undefined);
  }
}

/**
 * The output shape and camera a shot is pictured with: a scene carries one camera, named after the project size
 * (`size-1080x1920`); older shots use their 16:9 framing.
 */
export function framingOf(shot: Shot): { format: FormatDef; camera: Camera } {
  const sized = Object.entries(shot.cameras).find(([k]) => k.startsWith('size-'));
  if (sized) {
    const [w, h] = sized[0].slice(5).split('x').map(Number);
    return { format: { id: sized[0], label: '', ratio: `${w}:${h}`, w, h }, camera: sized[1] };
  }
  return { format: formatById('yt'), camera: shot.cameras.yt };
}

class ShotPictures {
  private stage: StageView | null = null;
  private ready: Promise<void> | null = null;
  private loaded = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, { key: string; url: string }>();

  private init(): Promise<void> {
    if (this.ready) return this.ready;
    // The renderer needs a host in the page. Keep it out of sight and out of the accessibility tree.
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '180px', pointerEvents: 'none' });
    document.body.appendChild(host);
    this.stage = new StageView();
    // Pictures are drawn on request (renderFrame), so this hidden stage never needs to redraw itself each frame.
    this.ready = this.stage.init(host).then(() => { this.stage!.app.ticker.stop(); });
    return this.ready;
  }

  /** The cached picture of a shot (at a frame), if it is still current. */
  cached(shot: Shot, frame?: number): string | null {
    const hit = this.cache.get(`${shot.name}@${frame ?? 'mid'}`);
    return hit && hit.key === JSON.stringify(shot) ? hit.url : null;
  }

  /** A JPEG data URL of one frame (the middle one by default) of the shot in the 16:9 framing, `width` pixels wide. Calls run one at a time. */
  picture(project: Project, shot: Shot, width = 480, frame?: number): Promise<string> {
    const key = JSON.stringify(shot), slot = `${shot.name}@${frame ?? 'mid'}`, hit = this.cache.get(slot);
    if (hit?.key === key) return Promise.resolve(hit.url);
    const run = this.queue.then(async () => {
      const again = this.cache.get(slot);
      if (again?.key === key) return again.url;
      await this.init();
      const stage = this.stage!;
      await prepareStage(stage, project, shot, this.loaded);
      const { format, camera } = framingOf(shot);
      stage.draw(finishedFrame(project, shot, frame ?? Math.floor(shot.length / 2)), { format, camera });
      // `width` is the longer side, so tall (Reels) pictures are not huge.
      const url = stage.renderFrame(format, camera, width / Math.max(format.w, format.h)).toDataURL('image/jpeg', 0.85);
      this.cache.set(slot, { key, url });
      return url;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Re-imported art: draw it fresh next time. */
  forget(character: string) { this.loaded.delete(character); this.cache.clear(); }
}

/** The one picture maker for the whole app. */
export const pictures = new ShotPictures();
