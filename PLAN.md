# Rig Animation Tool: plan and handover

Read this first if you are picking the project up. It says what the tool is, what the owner has decided,
what is built, how the code is laid out, how to check your work, and what to do next.
`README.md` is the user-facing guide; this file is for whoever works on the code.

> **New direction (November 2026).** The owner's improvement plan is in [`docs/improvement-plan.md`](docs/improvement-plan.md):
> a storyboard home, a shot editor with an inspector, scene-level sound, and a cut list. Where it disagrees with this file
> (for example auto-record on by default, the five steps removed, controllers and rig levels cut), **the improvement plan wins**.
> Sections 2, 5 and 8 below describe the tool as built before that plan.
>
> Motion and interaction polish follows the design-engineering-craft skill in `.claude/skills/design-engineering-craft/`.
> Shared behaviour lives in `src/ui/motion.ts`: only popovers, folded groups and the side panel animate; the stage, the timeline,
> frame stepping and keyboard actions never do.

## 1. What this is

A free, self-owned web app for **rigging layered 2D characters and animating them**: import art, rig it,
pose it, keyframe it, add sound and lip sync, and export video. It runs entirely in the browser as static files.

The owner draws characters in Illustrator (and may use Procreate). Dialogue and subtitles are likely to be Japanese.

### Principles (do not break these without asking the owner)

1. **Own the data.** A project is a folder of plain files (SVG, PSD, JSON, PNG, audio). If the app breaks, the files stay readable.
2. **No subscription, no lock-in, no AI services, no accounts.** Only free open-source libraries. The finished tool makes no online calls.
   The single exception the owner asked for: loading a Google font by name, and only when the user adds one.
3. **Simple first. This must not become another Adobe product.** Show only what the next action needs. The stage is the interface.
   See section 5 for the concrete rules.
4. **Desktop browsers only**, English interface. No tablet or phone layout.
5. **Seamless joints.** Limbs are split at every joint and drawn lines first, fills second.

### Wording

Describe it as a **rigging and motion animation** tool. The owner has asked not to call it comic animation or to frame features around comics.

## 2. Decisions the owner has made

| Topic | Decision |
| --- | --- |
| Output | 24 fps, never above 1920 × 1080. Shapes: 16:9, 4:3, 9:16 (Shorts and Reels), 4:5 and 3:4 posts. |
| Timing | "1s / 2s / 3s" means frames held per drawing (ones, twos, threes). **Default is ones.** |
| Keyframes | **Manual.** The user presses K. Keep the keyframe timeline; do not replace it with a pose strip. An "Auto key" toggle exists and is off by default. |
| Edits off a key | Shown but not stored, flagged "Not keyed", dropped on leaving the frame. The owner accepted this. |
| Capture | Photo first, webcam second. Both exist. Runs locally. |
| Fonts | Local fonts, an uploaded font file, or a Google font by name. |
| Rig levels | Low, Medium, High on one shared skeleton. The level is worked out from the pieces; changeable under More. |
| Cast | Up to 3 acting characters per shot, any number of extras. |
| Layout | Five steps (Character, Scene, Animate, Sound, Export), panel closed by default, advanced settings under "More". |
| Layers | Images and text live on the timeline as layers with a start and end, like a video editor. |

Open with the owner (ask before acting): whether to merge Shorts and Reels into one shape, cut import routes to
Illustrator and Procreate only, drop webcam capture, and let controllers take poses straight from the library.
These were proposed as simplifications; the owner has only approved the layout changes so far.

## 3. Status

Original build plan: six phases. Phases 1 to 5 are built. Phase 6 is not started.

| Phase | Scope | State |
| --- | --- | --- |
| 0 Foundation | Setup, placeholder character, test exports from the five drawing apps | Setup and placeholder done. **Real exports from the apps never tested.** |
| 1 Rig and pose | SVG and PSD import, pivots, FK, IK, two-pass outlines | Done. Gate met: elbow folds 150° with no seam. |
| 2 Library | Swaps, pose library, project save and load | Done. Gate met: a saved pose fits a second character. Plus controller pads (joystick, slider). |
| 3 Scenes and timeline | Templates, extras, keyframes, onion skin, framing per shape | Done. |
| 4 Sound and lip sync | Dialogue, music, text, subtitles, mouth keys, video export | Done. Gate met on a 2 s shot (not a 10 s one). |
| 5 Camera capture | Photo and webcam pose capture | Done. Tested on a rendered drawing and a fake camera, never on a real person. |
| 6 Polish | Offline install (PWA), shortcuts, export presets | **Not started.** |

Added beyond the plan: undo and redo, part-by-part import, the naming-convention help, controller pads,
the step-based layout, timeline layers.

## 4. How the code is laid out

TypeScript + Vite, PixiJS for drawing, no UI framework (a tiny `h()` DOM helper).

| Path | What lives there |
| --- | --- |
| `src/model/skeleton.ts` | Bones, joints, rig levels, piece and variant names, name clean-up. |
| `src/model/pose.ts` | Matrices, FK, 2-bone IK, `drawList()` (swaps resolved, two-pass order). No DOM. |
| `src/model/pads.ts` | Controller pads: nine-slot pose blending. |
| `src/model/shot.ts` | Shots, actors, keyframes, `evaluate()`, timing, mouth keys, layers, cameras, formats, `.srt`. |
| `src/model/types.ts` | `Rig`, `RigView`, `RigPiece`, `Pose`, `SavedPose`, import-time rasters. |
| `src/import/` | `svg.ts`, `psd.ts` (importers), `raster.ts` (line/fill split, masks, pivot guess), `build.ts` (rig + check report). |
| `src/render/stage.ts` | `StageView` (the one renderer, also used for export) and `ActorView` (one character). |
| `src/audio/audio.ts` | Decode, per-frame loudness, playback, offline mixdown. |
| `src/export/video.ts` | WebCodecs + `mp4-muxer`, PNG sequence. |
| `src/capture/` | `tracker.ts` (MediaPipe, loaded lazily), `mapping.ts` (body points to joint angles, pure), `panel.ts`. |
| `src/project/` | `project.ts` (project ↔ file map), `store.ts` (IndexedDB, folder, zip). |
| `src/ui/editor.ts` | `Editor` class: state, undo, drawing, stage pointer handling, stage bars. |
| `src/ui/panels.ts` | Side panel, one function per step. |
| `src/ui/timeline.ts` | Timeline bar and canvas. |
| `src/ui/importer.ts`, `controls.ts`, `dom.ts` | Import screen, pad widget, DOM helper. |
| `scripts/` | Placeholder generators, tracker setup, `check.mjs` (browser end-to-end check). |
| `tests/` | Vitest unit tests for the pure model code. |

### Ideas you need to hold in your head

- **One skeleton, angles not positions.** A pose stores degrees from each character's own rest pose, so it fits any character.
  Lower rig levels lock joints; `canBend()` is the single test.
- **Two-pass outlines.** At import each piece becomes a line image and a fill image (the fill is cut away where the piece's own
  visible strokes are). Each outline group (arm, leg, torso, head) draws all lines, then all fills. Mouth, eyes and hair layers
  are "overlay" slots drawn whole on top. See the comment on `splitPasses()`.
- **Swaps** are variant pieces named after what they replace (`mouth_a`, `forearm_L_bent`, shared `hand_fist`). `drawList()` picks.
- **Working pose vs stored pose.** `Editor.poses` holds what is on screen per actor. `Editor.edited()` decides where a change goes:
  the actor's base pose (no keys yet), the key on this frame, or nowhere (`unsaved`).
- **`evaluate(shot, actor, frame)`** is the only place timeline maths happens: key blending, hold, timing on ones/twos/threes, mouth keys.
- **Undo is whole-state JSON snapshots** taken in `Editor.commit()` after each finished action. If you add state that should undo,
  add it to `snapshot()` and `restore()`. Pose thumbnails are kept out of snapshots on purpose.
- **Cameras.** One per output shape. Shapes without `custom: true` follow the 16:9 camera (`syncCameras()`).
- **Layers.** Image layers are `shot.backgrounds` (name kept so old files open) with optional `start`, `end`, `opacity`, `front`.
  Text layers are `shot.texts` with `kind: 'text'`. Subtitles are `kind: 'subtitle'` and are laid out per output shape, not on the stage.
- **The renderer is shared.** `Editor.outputFrame()` draws a frame for export with the same code the editor uses, into a render texture.

### Project file format

```
characters/<name>/source/<files>   untouched art
characters/<name>/rig.json         level, pivots, limits, draw order, importMode
poses/<name>.json + .png           saved pose and thumbnail
controls/<name>_<id>.json          controller pad
scenes/<name>.json                 scene template
shots/<name>.json                  actors, keys, mouth keys, layers, cameras, audio clips, text
backgrounds/ audio/ fonts/         files the shots use
project.json                       Google font names
```

On load, each character's source art is re-imported and the saved `rig.json` is laid back over it.

## 5. Interface rules

These came out of a review with the owner. New features must fit them.

1. **The stage is the interface.** Things you change constantly sit on the thing itself (the bar above the selected character).
2. **One main action per step**, placed on the stage, top left.
3. **The side panel starts closed.** "More options" opens it. Inside it, anything advanced is a folded `more()` group.
4. **Defaults do the setup.** Prefer working something out over asking (rig level, mouth flaps, framing of other shapes).
5. **Empty screens say what to do next.**
6. **No confirmation dialogs.** Make it undoable instead.
7. **Keep the resting control count low.** Animate currently shows about twelve controls outside the stage; the target is lower. Do not add to it.
8. **Plain words.** No icon-only buttons, no internal terms, sentence case. Say "step", not "tab".

## 6. Running and checking

```bash
npm install          # also copies the tracker engine into public/mediapipe
npm run dev          # http://localhost:5173
npm test             # unit tests
npm run build        # static app in dist/
```

End-to-end check (needs `npm run dev` running in another terminal; uses Playwright with Chromium):

```bash
node scripts/check.mjs check-output                 # everything, a few minutes
node scripts/check.mjs check-output pose animate    # chosen sections
```

Sections: `import pose animate scene sound layers capture export save`. Screenshots land in the output folder; look at them,
since several past bugs were only visible there.

Things that will trip you up:

- **The app reopens the last project** from IndexedDB. Tests use a fresh browser context per run.
- **The checks open the panel and all "More" groups** through `editor.panelOpen`, `editor.openAll` and `timeline.moreOpen`.
  In dev the editor is on `window.__rig`.
- **Hashed build files.** `dist/assets` names change every build. When republishing the hosted copy, remove the old names.
- **The hosted artifact cannot serve `.psd` or `.task` files** and blocks downloads and the camera. PSD placeholder, capture and exports only work locally.
- **Regenerating placeholders:** `npm run placeholder` writes the SVGs; `node scripts/make-placeholder-psd.mjs` (dev server running) writes the PSDs from them.
- **`hidden` needs the `[hidden] { display: none !important }` rule** in `style.css`, because several hidden elements are flex containers.
- **The test browser has no AAC encoder**, so exports there fall back to Opus sound. Chrome and Edge should give H.264 with AAC; this has not been confirmed on the owner's machine.
- **The repository is `thetinywisdom/tinyrig`.** `node_modules`, `dist` and `public/mediapipe` are not committed; `npm install` recreates the last one.

## 7. Known gaps

- Real exports from Illustrator, Figma, Affinity Designer, Penpot and Procreate are untested. Name clean-up rules follow each app's documented behaviour.
- Penpot drops layer names in SVG; the planned naming step in the importer is not built.
- Controllers blend joint angles only. They do not switch swaps.
- Layers cannot be keyframed (no moving, scaling or fading over time) and have no on-stage resize or rotate handles.
- The stacking order is fixed in bands: back layers, characters, front layers, text. A layer cannot sit between two characters.
- Capture works from the front view only and leaves feet as posed.
- Shared hands exist; shared feet do not.
- No mesh deformation (decided for version 1).
- Video export has only been verified for a 2 s shot at 1920 × 1080.
- Scene templates are not covered by undo.

## 8. What to do next

In rough priority order. Confirm with the owner before starting anything marked *ask*.

1. **Test with the owner's real Illustrator file.** This is the biggest unknown. Fix what the importer gets wrong.
2. **Layer basics the owner will expect from a video editor:** on-stage resize and rotate handles, fade in and out, duplicate, rename.
   Then keyframed position, scale and opacity for layers.
3. **Free stacking order:** one ordered list of characters and layers, so a layer can sit between characters.
4. **Reduce resting controls in Animate** toward seven (rule 7).
5. **Phase 6:** installable offline app (PWA), keyboard shortcut list, export presets ("export all shapes").
6. *Ask:* the simplifications listed at the end of section 2.
7. **A 10-second talking shot exported in the owner's Chrome**, to close the phase 4 gate properly and confirm H.264 with AAC.

## 9. Sources

The original build plan is a Claude doc titled "Rig Animation Tool — Build Plan" owned by the project owner. It holds the art input
contract, the per-app export guide and the risk table. Where this file and that plan disagree, this file reflects later decisions.
