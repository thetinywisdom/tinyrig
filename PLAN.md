# Rig Animation Tool: plan and handover

Read this first if you are picking the project up. `README.md` is the user-facing guide.

## 1. What this is now (restarted November 2026)

The owner restarted the app from zero, keeping three things they liked:

1. **Placing joints** on a drawing, and **saving a pose**.
2. **Several angles** of one character: front, **3/4**, side, back.
3. **The storyboard** as home.

Everything else (the shot editor, inspector, timeline, sound lanes, filmstrip, modes, controllers, templates) was removed.

The core idea is the owner's: **start from a real photo or the webcam, "rig" the photo, and the character follows.**
You act the pose yourself; the app finds your body and draws dots on it; you drag any dot that is off; your
character copies the pose, in the angle you stand at. A panel is a few such poses in order, and the app moves
from one to the next (**pose to pose**: no timeline, no keys).

Owner's decisions (do not change without asking):

| Topic | Decision |
| --- | --- |
| Animation | Pose to pose. No timeline. |
| Code | Reuse the engine (import, joints, angles, drawing, tracking, export); rebuild every screen. |
| First version | Backgrounds, video export, pose from a photo. No sound for now. |
| Takes | Both photos and webcam. A webcam take: the app picks key poses from a few seconds of video. |
| Angles | The app picks the angle from the photo (front, 3/4, side, back); you can override it. |

Principles that still hold: own your data (plain files), no accounts, no AI services, offline; the one online
call is a Google font if added. Desktop browsers. Plain words, no confirmation dialogs (undo instead).
The owner rejected the earlier editor as too complex: **every new control has to earn its place.**

## 2. Screens

1. **Storyboard** (home): every panel is a **scene**. Its picture is what the scene's camera sees first, in the
   project's shape. Header: project **size** (Reels, Full HD, Square, 4:5, custom; one per project), **Cast** (the
   shared characters), Project menu. Double-click a scene to open it.
2. **Inside a scene**, the header is breadcrumbs and a switch: `Episode / 03 Scene ▾ / ( Rig | Animate )`, then
   length, saved, **Play scene**.
   - **Rig**: who is in the scene (add from the cast, or take out) and their rigs. A change here makes the scene's
     own copy of that rig (**tweaked here**); **Reset to shared** drops it, **Save to shared** copies it over the
     shared rig. Same rig editor as Cast: angles, named nodes, drag to connect, layers, Simple/Medium/Complex.
   - **Animate**: an endless canvas. Characters and images are **layers**, one stack front to back (drag a lane name
     up or down). Each character has a lane of poses acted from photos or the webcam. The **camera** is a frame in
     the project's shape with its own lane of keys: it **moves** (Smooth, Linear, Snap) or **cuts** into each key.
     Quick shots: Wide, Medium, Close-up. Only what is inside the frame is exported.
   - Timeline: solid black blocks for poses (drag the body to slide, the right edge to hold longer), light blocks
     for images (drag the ends), squares for camera keys; click the ruler to move the playhead.
3. **Cast**: the shared characters and their rigs (the old Characters screen).

## 3. Status

| Step | State |
| --- | --- |
| 1. 3/4 angle; reading the angle from a photo | Done. `quarter` view, art names, `readFacing()` (depth first, shoulder width as fallback), placeholder 3/4 drawing. |
| 2. Act it out from photos | Done: photos and single webcam photos, dots, angle, flip, poses, holds, Play, background, saved poses. |
| 3. Characters screen and new app shell | Done. Old editor deleted. |
| 3b. Half body (from the waist up) | Done. Tracker guesses outside the photo are ignored (`inPicture`); unseen parts keep their pose across angles; without hips the waist leans 30° at most; `bodyShown()` labels the photo. |
| 3c. Rigs of your own | Done. Named nodes per character (`Rig.nodes`), starting rigs human / 2 legs / 4 legs at Simple / Medium / Complex, drag-to-connect, add, rename, remove, layer-to-node, name matching. Layers with any name import as parts. |
| 3d. Scenes: Rig and Animate tabs, layers, camera keys, project size, scene rig tweaks | Done. `src/model/scene.ts`, `src/ui/scene.ts`, `src/ui/animate.ts`. Older acted panels move onto lanes and layers when opened. |
| 3e. Who is who: one photo with two people driving two characters | Not started (the tracker reads one person). |
| 4. Webcam takes (a few seconds of video, key poses picked) | Not started. |
| 5. Video export of the storyboard | **Next.** Render each scene through its camera at the project size. |
| 6. Tune the angle thresholds on the owner's real photos | Waiting for photos. |

## 4. Code

TypeScript + Vite, PixiJS, no UI framework (`h()` DOM helper).

| Path | What lives there |
| --- | --- |
| `src/model/scene.ts` | A scene: cast, lanes of poses, image layers, the stack, camera keys (`cameraAt`), project size, rig tweaks, `compileScene()` → a `Shot` the renderer draws; `upgradeScene()` for older panels. Pure, tested. |
| `src/model/act.ts` | Shared types (`CastMember`, `ActedPose`) and the older `Moment` model (read when upgrading). |
| `src/model/storyboard.ts` | Panels (`cast`, `moments`, `background`, or a sketch and typed duration), scene time. |
| `src/model/skeleton.ts`, `pose.ts`, `types.ts`, `shot.ts` | The engine: bones, joints, views (`front`, `quarter`, `side`, `back`), FK/IK, keys and `evaluate()`. |
| `src/model/rig.ts` | Rigs of your own: nodes, starting rigs and their detail levels, `skeletonOf(rig)`, name matching (`sameName`, `displayName`), `attachByName`. Pure, tested. |
| `src/capture/tracker.ts` | MediaPipe pose (local files), points in pixels with depth `z`. |
| `src/capture/facing.ts` | Front / 3/4 / side / back and which way you look, from the points. Pure, tested. |
| `src/capture/mapping.ts` | Points → joint angles against a drawing's rest pose (any angle). |
| `src/capture/act.ts` | `poseFromPoints()`: angle, flip, angles, spine limit. The dots shown (`DOTS`, `BONES`). |
| `src/ui/storyboard.ts`, `scene.ts`, `animate.ts`, `characters.ts`, `start.ts`, `importer.ts`, `sample.ts` | The screens. `scene.ts` is the header and the Rig / Animate switch; Rig is `characters.ts` in scene mode. |
| `src/render/stage.ts`, `thumb.ts` | The renderer, and the shared picture maker for panel and pose thumbnails. |
| `src/main.ts` | Routing between screens, saving, project menu. |

Ideas to hold:
- **A rig is named nodes.** `Rig.nodes` (missing = the old human rig). A node's `id` keys its point and its angle; its
  `bone` is the part layers attach to. The starting rigs reuse the human joint ids (a front leg is `shoulder_L`, a back
  leg `hip_L`), so acting from a photo also moves 2- and 4-legged creatures. Nodes you add get ids `n_<k>`.
- **A pose is angles, not positions.** Each character stands where it was cast; poses turn its parts.
- **Mirror.** A photo is copied as it looks (your left drives the character's left). A flipped drawing is read the
  other way round (`mirror XOR flip` in `poseFromPoints`).
- **Each drawing says which way it looks** (`RigView.faces`, default left). The app flips it to match you.
- **The tracker knows real people.** It reads a front-facing cartoon, but not a cartoon side view. Real photos are the input.

Project files: as before plus `photos/` (the photos you acted from) and `storyboard.json` (panels with cast and poses).

## 5. Checking

```bash
npm install && npm run dev        # http://localhost:5173
npm test                          # unit tests
node scripts/check.mjs check-output                     # browser check, a few minutes
node scripts/check.mjs check-output act characters      # chosen sections: storyboard import act characters save
```

The act check uses `scripts/fixtures/pose-photo.png`, the placeholder drawn in a known pose, so it does not
depend on how the tracker reads a freshly drawn picture. Dev hooks: `window.__sb`, `__scene`, `__anim`, `__chars`, `__project()`.

## 6. History

`docs/improvement-plan.md` and the earlier phases (shot editor, scene sound) are superseded by this restart.
The git history has them if anything needs to come back.
