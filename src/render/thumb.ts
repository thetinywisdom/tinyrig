// Small pictures of shots for the storyboard: one frame, drawn by the same renderer the editor and export use.
// One hidden stage is shared by every panel and kept until the storyboard closes.
import type { Project } from '../project/project';
import { evaluate, formatById, visibleLayers, visibleTexts, type Shot } from '../model/shot';
import { unlockedJoints } from '../model/skeleton';
import { StageView, type DrawActor } from './stage';

export class ShotPictures {
  private stage: StageView | null = null;
  private host: HTMLElement | null = null;
  private ready: Promise<void> | null = null;
  private loadedChars = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  private init(): Promise<void> {
    if (this.ready) return this.ready;
    // The renderer needs a host in the page. Keep it out of sight and out of the accessibility tree.
    this.host = document.createElement('div');
    this.host.setAttribute('aria-hidden', 'true');
    Object.assign(this.host.style, { position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '180px', pointerEvents: 'none' });
    document.body.appendChild(this.host);
    this.stage = new StageView();
    this.ready = this.stage.init(this.host);
    return this.ready;
  }

  /** A JPEG data URL of `frame` of the shot in the 16:9 framing, `width` pixels wide. Calls run one at a time. */
  picture(project: Project, shot: Shot, frame: number, width = 480): Promise<string> {
    const run = this.queue.then(() => this.draw(project, shot, frame, width));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async draw(project: Project, shot: Shot, frame: number, width: number): Promise<string> {
    await this.init();
    const stage = this.stage!;
    const actors: DrawActor[] = [];
    for (const a of shot.actors) {
      const entry = project.characters.find((c) => c.name === a.character);
      if (!entry) continue;
      if (!this.loadedChars.has(entry.name)) { stage.setCharacter(entry.name, entry.data.imp); this.loadedChars.add(entry.name); }
      const pose = evaluate(shot, a, frame);
      if (entry.data.rig.views[pose.view]) actors.push({ id: a.id, rig: entry.data.rig, pose, unlocked: unlockedJoints(entry.data.rig.level), extra: a.role === 'extra' });
    }
    const layers = visibleLayers(shot, frame);
    for (const l of layers) {
      const bytes = project.assets.get(`backgrounds/${l.file}`);
      if (bytes) await stage.setBackground(l.file, bytes).catch(() => undefined);
    }
    const format = formatById('yt'), camera = shot.cameras.yt;
    stage.draw({ shot, actors, texts: visibleTexts(shot, frame).filter((t) => t.kind === 'text'), layers }, { format, camera });
    return stage.renderFrame(format, camera, width / format.w).toDataURL('image/jpeg', 0.85);
  }

  /** Re-import replaced a character's art: draw it fresh next time. */
  forget(character: string) { this.loadedChars.delete(character); }

  dispose() {
    this.stage?.destroy();
    this.host?.remove();
    this.stage = null; this.host = null; this.ready = null;
    this.loadedChars.clear();
  }
}
