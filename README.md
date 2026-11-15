# Rig Animation Tool

A free, self-owned web app for rigging layered characters and animating them: posable, outlined
cut-out puppets, a keyframe timeline, sound with lip sync, and video export. Static files only: no accounts, no AI services.
The only thing that ever goes online is a Google font, and only if you add one.

It follows the owner's improvement plan (`docs/improvement-plan.md`): a **storyboard home**, a **shot editor** with a filmstrip and an
inspector, and **scene-level sound**. Phases 0 to 3 of that plan are built; Phase 4 (whole-scene export, transitions, camera moves) is next.

## Run it

```bash
npm install
npm run dev        # open the printed address in Chrome or Edge
```

```bash
npm run build      # static app in dist/, host anywhere or open offline
npm test           # unit tests
```

With `npm run dev` running in another terminal, the browser check drives the whole app:

```bash
node scripts/check.mjs check-output
```

## The storyboard

A project is one scene, and a scene starts as a storyboard: a grid of panels read like a comic page.
The first screen offers **New scene** (with a three-panel sample you can remove with **Clear sample**) and **Open scene**.

- Each panel has a **sketch**, free-text **notes** (dialogue, action, camera, sound) and a **duration**, shown as `#4 · 3.2s`. Click the duration or the notes to edit them.
- Once a panel is animated it shows a frame of its shot. **Show sketches** brings the sketches back.
- **Add panel** at the end, or **+** in the gap between two panels. Drag a panel to move it.
- Drop many sketch files on the grid to get one panel per file, in filename order. Drop one file on a panel, or paste an image (Ctrl+V), to set its sketch.
- Select a panel, then: **Ctrl+D** duplicates, **Delete** removes (with Undo), **Enter** or a double-click opens its shot, arrow keys move between panels.
- The header shows the scene name and total runtime, for example `1:48 · 27 shots`.
- **← Storyboard** in the editor goes back. A reload reopens the screen you were on.

## The shot editor

Open a panel (double-click, Enter, **Animate**, or a shot in the filmstrip) to animate it.

- **Top:** ← Storyboard, the **filmstrip** of every shot (click one to go to it), Undo, Redo, **Export**, the save state, Project.
- **Stage:** **+ Add** (top left) adds a character (the scene's cast first), a background image, a foreground image or a text.
  The character you picked has a small bar above it: view, flip, mouth and hands.
- **Inspector (right):** the **Layers** list, then whatever is selected.
  - Layers, front at the top: Camera, texts, then every image and character in one stack. **Drag a row** to change what is in front,
    so an image can sit between two characters. **Hide** and **Lock** are one click each. A background image starts locked, so posing a
    character never moves it.
  - A **character**: acting or extra, size, **Move in every frame**, Reset pose, **Pose from a photo**, **Edit rig**, swaps, mouth shapes,
    the pose library, timing. An **extra** stands still or **loops** through a few poses (no keys needed).
  - An **image**, a **text**, the **camera** (output shape and framing), a **sound**, or (nothing selected) the **shot**: its storyboard notes,
    subtitles, font, stage, and reusable setups.
- Click empty stage or press **Esc** to go back to the shot. Everything is undoable, so nothing asks for confirmation.

Press **?** for the shortcut list: Space plays, `,` and `.` step a frame, `[` and `]` go to the previous and next shot, **K** keys,
`\` switches the timeline between this shot and the whole scene, Delete removes the selected image, text or sound, Ctrl+↑ goes back to the storyboard.

### Sound

Sound belongs to the scene, so it plays straight across the cuts; animation stays inside each shot.

- The timeline has three lanes: **Voice** (with each speaker's mouth row under it), **Sound effect** and **Music**. **+ Add** on a lane puts a
  file at the playhead. Sound effect also offers a starter set: phone buzz, door knock, door closing, footsteps.
- **Record** on the Voice lane, or **Record line** on a selected storyboard panel, records a scratch take from the microphone. It starts at the
  beginning of the shot, replaces that shot's last take, and the shot becomes as long as the take.
- A sound is pinned to the shot it starts in, so moving, adding or resizing shots keeps every line with its picture. Drag a sound to move it,
  across cuts too.
- **Whole scene** (or `\`) shows every shot back to back with the sound; **Play the scene** plays every shot and sketch in turn with the sound.
- Mouth shapes are set by hand: pick the character, then click a shape in its **Mouth** section. A rough start from a line's loudness is under
  the voice sound's **Quick mouth flaps**.

### Keyframes

- **Auto-record poses** is on: every pose you make is saved as a key on its frame, and the bottom bar says "Pose saved · frame 48". Pose two frames and press Space to see it move.
- **K** (or **Set key**) keys the current pose by hand. A square key is a hold.
- Untick **Auto-record poses** under Timeline options to key only with K. Then a change made on a frame with no key is shown but **not stored**; the timeline says "Not keyed", and leaving the frame drops it (Ctrl+Z brings it back).
- **1s / 2s / 3s** is the timing for the whole shot: a new drawing every frame, every second frame, or every third. Default 1s, set under Timeline options. Override it per character or per frame range under More in Animate. Swaps always step.
- **After this key**: Ease, Even or Hold, per key.
- Space plays, arrow keys step one frame (Shift: 12), Ctrl+Z / Ctrl+Shift+Z undo and redo.

### Moving the view

- Dragging with the left button only poses or moves things. It never moves the view.
- Move the view: hold **Space** and drag, drag with the middle button, or scroll with two fingers on a trackpad (the mouse wheel scrolls, Shift+wheel sideways).
- Zoom: pinch on a trackpad, or Ctrl+wheel. **Fit** puts the frame back in the window.

### Output shapes

Every shot is drawn on a stage larger than any frame and keeps one framing per shape, so a 16:9 shot becomes
a 9:16 Reel by moving the frame.

| Shape | Size |
| --- | --- |
| YouTube 16:9 | 1920 × 1080 |
| YouTube Shorts 9:16 | 1080 × 1920 |
| Instagram Reels 9:16 | 1080 × 1920 |
| Instagram post 4:5 | 1080 × 1350 |

Choose the shape and frame it by selecting **Camera** in the layer list. 4:3 and 3:4 are cut in the plan; old shots keep their framings.

The inner guide line marks the area platform buttons usually leave clear. It is approximate.

### Video

Export uses the browser's own encoders. Chrome and Edge give H.264 video with AAC sound. A browser without
those falls back to VP9 or AV1 video and Opus sound, and the export says so.

## Art: naming convention

The import screen shows the full table. In short:

- `char_<name>` holds views `front`, `side`, `back`, which hold the pieces (`head`, `chest`, `pelvis`, `upperarm_L`, …).
- **Swaps** are drawn in place and named after what they replace: `mouth_a`, `eyes_closed`, `forearm_L_bent`, `head_angry`.
- **Shared hands** have no side (`hand_fist`): draw once, pointing down, wrist at the top edge. The app puts them on either wrist.
- Lip sync uses `mouth_rest`, `mouth_mbp`, `mouth_a`, `mouth_e`, `mouth_o`, `mouth_u`, `mouth_fv`, `mouth_l`.
- Import a whole SVG, one PSD per view (Procreate, `_line` over `_fill`), or one SVG per piece.

## Project folder

Everything saves to the browser as you work. The Project menu also saves to a real folder (Chrome, Edge)
and exports or opens a zip. All of it is plain files:

| Path | Holds |
| --- | --- |
| `characters/<name>/source/` | The original art files, untouched |
| `characters/<name>/rig.json` | Rig level, pivots, limits, draw order |
| `poses/<name>.json` and `.png` | A saved pose and its thumbnail |
| `scenes/<name>.json` | A reusable setup: stage, images, characters, framing |
| `shots/<name>.json` | One shot: characters, keys, mouth keys, image layers, stack order, cameras, text |
| `storyboard.json` | The scene's panels (notes, durations, sketch, shot) and its sound clips |
| `sketches/` | The panels' sketch images |
| `backgrounds/`, `audio/`, `fonts/` | The files shots and sound use (scratch takes and starter effects go in `audio/`) |

## Code layout

| Path | Holds |
| --- | --- |
| `src/model/` | Skeleton and names, rig and pose types, FK, IK, swaps, shots, the layer stack, the storyboard and scene sound (no DOM) |
| `src/import/` | SVG and PSD importers, line/fill splitting, pivot guessing, check report |
| `src/render/stage.ts` | The one PixiJS renderer, for the editor and for export |
| `src/audio/`, `src/export/` | Playback, loudness, mixdown, recording, starter effects; MP4 and PNG export |
| `src/capture/` | Body tracking (MediaPipe, runs locally) and turning body points into joint angles |
| `src/ui/` | Start screen, storyboard, importer, editor, inspector, filmstrip, timeline, scene player |
| `src/project/` | Project file format and storage (browser, folder, zip) |
| `public/placeholder/` | Placeholder character at all three levels, as PSDs and as part files |
| `public/models/`, `public/mediapipe/` | The tracking model and its engine |

## Known gaps

- Exports from Illustrator, Figma, Affinity, Penpot and Procreate are untested with real files; the name
  clean-up rules follow each app's documented behaviour. Penpot's naming step is not built.
- Capture works from the front view. Feet are left as posed.
- Layers cannot be keyframed or resized on the stage yet; size and opacity are numbers in the inspector.
- Export is one shot at a time; exporting the whole scene is Phase 4. Mouths are manual; automatic mouths are for later.

`PLAN.md` has the full status, decisions and next steps for whoever continues the work.
