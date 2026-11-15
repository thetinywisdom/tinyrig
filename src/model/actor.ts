// Putting a character into a shot. No DOM, so the editor and the sample scene share it.
import { restPose } from './pose';
import { MAX_ACTORS, uid, type Actor, type Shot } from './shot';
import { VIEWS } from './skeleton';
import type { Pose, Rig } from './types';

/** A new actor for `character`, standing in its rest pose and sized to sit comfortably in a 1080-tall frame. */
export function placeActor(shot: Shot, character: string, rig: Rig): Actor | null {
  const viewId = VIEWS.find((v) => rig.views[v]);
  if (!viewId) return null;
  const view = rig.views[viewId]!;
  const boxes = Object.values(view.pieces).filter((p) => !p.shared).map((p) => p.bbox);
  const top = Math.min(...boxes.map((b) => b.y)), bottom = Math.max(...boxes.map((b) => b.y + b.h));
  const left = Math.min(...boxes.map((b) => b.x)), right = Math.max(...boxes.map((b) => b.x + b.w));
  const height = bottom - top, scale = height > 1000 || height < 500 ? Math.round((800 / height) * 100) / 100 : 1;
  const n = shot.actors.length, slot = [0, -1, 1][n % 3] * 420 + Math.floor(n / 3) * 120;
  const role = shot.actors.filter((a) => a.role === 'actor').length < MAX_ACTORS ? 'actor' : 'extra';
  const centre = { x: shot.stage.w / 2 + slot, y: shot.stage.h / 2 };
  const base: Pose = {
    ...restPose(view, viewId), scale,
    root: { x: centre.x + (view.rootPivot.x - (left + right) / 2) * scale, y: centre.y + (view.rootPivot.y - (top + bottom) / 2) * scale },
  };
  return { id: uid(), character, role, base, keys: [], mouth: [] };
}
