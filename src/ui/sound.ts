// Putting sound on the scene: files, starter effects and scratch takes. Used by the editor's timeline
// lanes and by the storyboard's Record button.
import { effectWav, EFFECTS, type EffectId } from '../audio/effects';
import { Recorder, soundSeconds, type Take } from '../audio/record';
import { uid } from '../model/shot';
import { setPanelSeconds, type Lane, type Panel, type SceneClip } from '../model/storyboard';
import type { Project } from '../project/project';
import type { Editor } from './editor';
import { pickFiles } from './inspector';

export const STARTER_EFFECTS = (Object.keys(EFFECTS) as EffectId[]).map((id) => ({ id, label: EFFECTS[id].label }));

/** A file name in audio/ that is not taken yet. */
function freeName(project: Project, name: string): string {
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let out = name;
  for (let i = 2; project.assets.has(`audio/${out}`); i++) out = `${stem}-${i}${ext}`;
  return out;
}

/** Put a sound on a lane at the playhead of the open shot, and select it. */
async function place(ed: Editor, lane: Lane, file: string, bytes: Uint8Array) {
  const panel = ed.panel_(), sb = ed.project.storyboard;
  if (!panel || !sb) return;
  try { await ed.audio.load(file, bytes); } catch { ed.say(`The browser could not read ${file} as sound. Try a WAV, MP3 or M4A file.`); return; }
  ed.project.assets.set(`audio/${file}`, bytes);
  const actor = ed.sel();
  const clip: SceneClip = {
    id: uid(), lane, file, panel: panel.id, offset: ed.frame, gain: lane === 'music' ? 0.5 : 1,
    speaker: lane === 'voice' && actor?.role === 'actor' ? actor.character : undefined,
  };
  (sb.sound ??= []).push(clip);
  ed.select('clip', clip.id);
  ed.refresh();
}

export function addSoundFile(ed: Editor, lane: Lane) {
  pickFiles('audio/*', false, async (files) => {
    const f = files[0];
    if (f) await place(ed, lane, freeName(ed.project, f.name), f.bytes);
  });
}

export async function addStarterEffect(ed: Editor, id: EffectId) {
  const file = `sfx_${id}.wav`;
  // The same effect used twice shares one file.
  const bytes = ed.project.assets.get(`audio/${file}`) ?? effectWav(id);
  await place(ed, 'sfx', file, bytes);
}

// --- scratch takes ---------------------------------------------------------------------
const recorder = new Recorder();
let target: string | null = null;
let ticker = 0;

export const recordingState = () => ({ active: recorder.active, seconds: recorder.seconds, panel: target });

/**
 * Keep a take on a panel: it goes on the Voice lane at the start of the panel, replacing the panel's last take,
 * and the panel (and its shot) become as long as the take.
 */
export function storeTake(project: Project, panel: Panel, take: Take, seconds: number, speaker?: string): SceneClip {
  const sb = project.storyboard!;
  const n = sb.panels.indexOf(panel) + 1;
  const file = freeName(project, `take_shot${n}.${take.ext}`);
  const old = (sb.sound ?? []).filter((c) => c.take && c.panel === panel.id);
  sb.sound = (sb.sound ?? []).filter((c) => !old.includes(c));
  // The old take's file stays in audio/, so Undo can bring the old take back.
  project.assets.set(`audio/${file}`, take.bytes);
  const clip: SceneClip = { id: uid(), lane: 'voice', file, panel: panel.id, offset: 0, gain: 1, take: true, speaker: speaker ?? old[0]?.speaker };
  sb.sound.push(clip);
  setPanelSeconds(panel, seconds, project.shots);
  return clip;
}

/** Start recording for a panel, or stop and keep the take. `done` runs after a take is kept (or recording fails). */
export async function toggleTake(panelId: string, onTick: (seconds: number) => void, keep: (take: Take) => Promise<void>, fail: (message: string) => void) {
  if (recorder.active) {
    clearInterval(ticker);
    const take = await recorder.stop();
    target = null;
    if (take && take.bytes.length) await keep(take);
    return;
  }
  try { await recorder.start(); } catch (err) { fail(err instanceof Error ? err.message : String(err)); return; }
  target = panelId;
  ticker = window.setInterval(() => onTick(recorder.seconds), 100);
}

/** The editor's Record button on the Voice lane: a take for the open shot. */
export async function toggleRecording(ed: Editor) {
  const panel = ed.panel_();
  if (!panel) return;
  if (!recorder.active) ed.stop();
  await toggleTake(panel.id,
    (s) => { const b = document.getElementById('record-take'); if (b) b.textContent = `Stop ${s.toFixed(1)}s`; },
    async (take) => {
      const seconds = (await soundSeconds(take.bytes)) ?? take.seconds;
      const actor = ed.sel();
      const clip = storeTake(ed.project, panel, take, seconds, actor?.role === 'actor' ? actor.character : undefined);
      await ed.audio.load(clip.file, take.bytes).catch(() => undefined);
      ed.evaluateAll();
      ed.frame = Math.min(ed.frame, ed.shot.length - 1);
      ed.select('clip', clip.id);
      ed.say(`Take kept: ${seconds.toFixed(1)} s. The shot is now that long.`);
      ed.refresh();
    },
    (message) => ed.say(message));
  ed.timeline.render();
}
