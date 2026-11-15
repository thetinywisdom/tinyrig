// The sample scene that New scene starts with: three panels of a desk scene.
// Panel 1 is finished (the placeholder character waves), panels 2 and 3 are rough sketches.
// "Clear sample" removes all of it.
import { placeActor } from '../model/actor';
import { newShot, setKey, uid } from '../model/shot';
import { newPanel, type Panel } from '../model/storyboard';
import type { Pose } from '../model/types';
import type { Project } from '../project/project';
import { readFiles } from './importer';

export const SAMPLE_CHARACTER_FILE = 'char_placeholder_high.svg';

/** A rough pencil line: a few wobbly passes, like a quick storyboard sketch. */
function pencil(g: CanvasRenderingContext2D, pts: [number, number][], passes = 2, wobble = 2.2) {
  for (let p = 0; p < passes; p++) {
    g.beginPath();
    pts.forEach(([x, y], i) => {
      const jx = x + (Math.random() - 0.5) * wobble, jy = y + (Math.random() - 0.5) * wobble;
      if (i) g.lineTo(jx, jy); else g.moveTo(jx, jy);
    });
    g.stroke();
  }
}
const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 28): [number, number][] =>
  Array.from({ length: n + 2 }, (_, i) => [cx + Math.cos((i / n) * Math.PI * 2) * rx, cy + Math.sin((i / n) * Math.PI * 2) * ry]);

function sketchCanvas(draw: (g: CanvasRenderingContext2D) => void): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = 960; c.height = 540;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbfaf7';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(52, 56, 66, 0.78)';
  g.lineWidth = 2.4;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  draw(g);
  return new Promise((resolve) => c.toBlob(async (b) => resolve(new Uint8Array(await b!.arrayBuffer())), 'image/png'));
}

/** Two people at a desk, seen from the side. */
const deskSketch = () => sketchCanvas((g) => {
  pencil(g, [[90, 470], [870, 470]], 1, 1.5); // floor
  pencil(g, [[250, 300], [710, 300]]); // desk top
  pencil(g, [[280, 300], [280, 470]]); pencil(g, [[680, 300], [680, 470]]);
  pencil(g, [[430, 300], [430, 270], [530, 270], [530, 300]]); // laptop
  pencil(g, [[530, 270], [560, 200]]);
  for (const [x, face] of [[180, 1], [790, -1]] as const) {
    pencil(g, ellipse(x, 175, 34, 40)); // head
    pencil(g, [[x + face * 18, 170], [x + face * 24, 170]], 1, 1); // eye
    pencil(g, [[x, 215], [x - face * 6, 330]]); // body
    pencil(g, [[x, 240], [x + face * 70, 290], [x + face * 120, 296]]); // arm on the desk
    pencil(g, [[x - face * 6, 330], [x + face * 60, 340], [x + face * 60, 470]]); // seated leg
    pencil(g, [[x - face * 40, 330], [x - face * 40, 470]], 1); pencil(g, [[x - face * 40, 330], [x + face * 30, 330]], 1); // chair
  }
  g.font = '600 26px system-ui, sans-serif';
  g.fillStyle = 'rgba(52, 56, 66, 0.7)';
  g.fillText('A', 120, 110); g.fillText('B', 820, 110);
  g.setLineDash([10, 8]);
  pencil(g, [[60, 40], [900, 40], [900, 500], [60, 500], [60, 40]], 1, 0.5); // push-in: start frame
  pencil(g, [[150, 90], [810, 90], [810, 450], [150, 450], [150, 90]], 1, 0.5); // end frame
  g.setLineDash([]);
  pencil(g, [[70, 50], [140, 82]], 1, 0.5); pencil(g, [[128, 70], [140, 82], [124, 84]], 1, 0.5); // arrow inwards
});

/** A phone buzzing on the desk, close up. */
const phoneSketch = () => sketchCanvas((g) => {
  pencil(g, [[40, 400], [920, 380]]); // desk edge
  pencil(g, [[350, 190], [610, 170], [640, 350], [380, 372], [350, 190]]); // phone, slightly turned
  pencil(g, [[372, 208], [596, 190], [620, 334], [398, 352], [372, 208]], 1, 1); // screen
  pencil(g, ellipse(500, 270, 26, 26), 1, 1);
  for (const s of [-1, 1]) for (const r of [40, 70]) {
    const x = s < 0 ? 330 - r * 0.6 : 660 + r * 0.6;
    pencil(g, [[x, 210 - r * 0.3], [x - s * 14, 240], [x, 270], [x - s * 14, 300], [x, 330 + r * 0.3]], 1, 1.4); // buzz lines
  }
  g.font = '700 46px system-ui, sans-serif';
  g.fillStyle = 'rgba(52, 56, 66, 0.72)';
  g.fillText('BZZT', 690, 140);
});

/** Angles for a quick wave with the character's left arm (the arm on the right as you look at it). */
function wavePoses(base: Pose): [number, Pose][] {
  const pose = (a: Record<string, number>): Pose => ({ ...structuredClone(base), angles: { ...base.angles, ...a } });
  const up = { shoulder_L: -150, neck: -6 };
  return [
    [0, pose({})],
    [10, pose({ ...up, elbow_L: -40, wrist_L: 0 })],
    [16, pose({ ...up, elbow_L: -10, wrist_L: 10 })],
    [22, pose({ ...up, elbow_L: -40, wrist_L: 0 })],
    [28, pose({ ...up, elbow_L: -10, wrist_L: 10 })],
    [34, pose({ ...up, elbow_L: -40, wrist_L: 0 })],
    [47, pose({ neck: 4 })],
  ];
}

/**
 * Add the sample to a project: the placeholder character, the waving shot and three panels.
 * Returns the panels, already marked as sample.
 */
export async function addSample(project: Project): Promise<Panel[]> {
  const res = await fetch(`placeholder/${SAMPLE_CHARACTER_FILE}`);
  if (!res.ok) throw new Error('The sample character is not available here.');
  const files = [{ name: SAMPLE_CHARACTER_FILE, data: await res.arrayBuffer() }];
  const data = await readFiles(files, 'whole', undefined, () => undefined);
  const name = data.rig.name;
  if (!project.characters.some((c) => c.name === name)) project.characters.push({ name, mode: 'whole', files, data });

  const shot = { ...newShot('Sample wave'), length: 48 };
  const actor = placeActor(shot, name, data.rig);
  if (actor) {
    shot.actors.push(actor);
    for (const [frame, pose] of wavePoses(actor.base)) setKey(actor, frame, pose, 'ease');
  }
  project.shots = project.shots.filter((s) => s.name !== shot.name).concat(shot);

  const [desk, phone] = await Promise.all([deskSketch(), phoneSketch()]);
  project.assets.set('sketches/sample_desk.png', desk);
  project.assets.set('sketches/sample_phone.png', phone);
  return [
    newPanel(uid(), { sample: true, shot: shot.name, duration: 2, notes: 'A turns to camera and waves.\nCamera: medium shot, still.' }),
    newPanel(uid(), { sample: true, sketch: 'sample_desk.png', duration: 4, notes: 'A and B at the desk.\nA: Did you see this?\nB: Not yet. Show me.\nCamera: slow push-in.' }),
    newPanel(uid(), { sample: true, sketch: 'sample_phone.png', duration: 1.5, notes: 'Close-up: the phone buzzes on the desk.\nSound: phone buzz.' }),
  ];
}

/** Remove the sample panels, their shots and sketches, and the sample character if nothing else uses it. */
export function clearSample(project: Project) {
  const sb = project.storyboard;
  if (!sb) return;
  const gone = sb.panels.filter((p) => p.sample);
  sb.panels = sb.panels.filter((p) => !p.sample);
  const shots = new Set(gone.map((p) => p.shot).filter(Boolean));
  project.shots = project.shots.filter((s) => !shots.has(s.name));
  for (const p of gone) if (p.sketch && !sb.panels.some((q) => q.sketch === p.sketch)) project.assets.delete(`sketches/${p.sketch}`);
  const used = new Set(project.shots.flatMap((s) => s.actors.map((a) => a.character)));
  project.characters = project.characters.filter((c) => used.has(c.name) || !c.files.some((f) => f.name === SAMPLE_CHARACTER_FILE));
}
