# Rig Animation Tool

A free, self-owned web app for rigging layered characters and animating them: posable, outlined
cut-out puppets, a keyframe timeline, sound with lip sync, and video export. Static files only: no accounts, no AI services.
The only thing that ever goes online is a Google font, and only if you add one.

**Built: phases 1 to 5** of the build plan (rig and pose, library, scenes and timeline, sound and lip sync, camera capture).
Phase 6 (offline install, shortcuts, export presets) is not started.

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

## The editor

The stage has the window. The work follows five steps along the top; each has one main action, placed on the stage.

| Step | Main action | What else is there |
| --- | --- | --- |
| **1 Character** | Import a character | Drag pivots on the stage. Under More: rig level, joint limits, draw order. |
| **2 Scene** | Add a character | Choose what to drag: characters, backgrounds or the framing. Under More: framing numbers, stage size, templates. |
| **3 Animate** | Set key (on the timeline) | Pose by dragging. View, flip, mouth and hands sit in a small bar on the character. "Pose from a photo" opens capture. |
| **4 Sound** | Add dialogue | Mouth flaps are made as soon as dialogue is added. Subtitles, on-screen text, music. Under More: font. |
| **5 Export** | Export video | PNG sequence, single frame, `.srt`. |

- **Add layer** on the timeline adds an image behind or in front of the characters, or a text. Each layer has its own row: drag its bar to move it in time, drag an end to trim it, click the row and drag the layer on the stage to place it.
- **More options** opens the side panel, which starts closed. Advanced settings inside it are folded until opened.
- **Timeline options** holds timing, easing, Auto-record poses, onion skin and zoom.
- The timeline shows only in Animate and Sound.
- The rig level is worked out from the pieces in the art; the other output shapes follow the 16:9 framing until you frame them yourself.
- Everything is undoable, including the pose library, so nothing asks for confirmation.

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
| YouTube 4:3 | 1440 × 1080 |
| YouTube Shorts 9:16 | 1080 × 1920 |
| Instagram Reels 9:16 | 1080 × 1920 |
| Instagram post 4:5 / 3:4 | 1080 × 1350 / 1080 × 1440 |

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
| `controls/<name>_<id>.json` | A controller pad and the poses in its slots |
| `scenes/<name>.json` | A scene template |
| `shots/<name>.json` | A scene plus its keyframes, mouth keys, layers, sound clips and text |
| `storyboard.json` | The scene's panels: notes, durations, which sketch and which shot |
| `sketches/` | The panels' sketch images |
| `backgrounds/`, `audio/`, `fonts/` | The files shots use |

## Code layout

| Path | Holds |
| --- | --- |
| `src/model/` | Skeleton and names, rig and pose types, FK, IK, swaps, controller pads, shots and timeline (no DOM) |
| `src/import/` | SVG and PSD importers, line/fill splitting, pivot guessing, check report |
| `src/render/stage.ts` | The one PixiJS renderer, for the editor and for export |
| `src/audio/`, `src/export/` | Playback, loudness and mixdown; MP4 and PNG export |
| `src/capture/` | Body tracking (MediaPipe, runs locally) and turning body points into joint angles |
| `src/ui/` | Importer, editor, panels, timeline, controller pads |
| `src/project/` | Project file format and storage (browser, folder, zip) |
| `public/placeholder/` | Placeholder character at all three levels, as PSDs and as part files |
| `public/models/`, `public/mediapipe/` | The tracking model and its engine |

## Known gaps

- Exports from Illustrator, Figma, Affinity, Penpot and Procreate are untested with real files; the name
  clean-up rules follow each app's documented behaviour. Penpot's naming step is not built.
- Controllers blend joint angles only; they do not switch swaps.
- Capture works from the front view. Feet are left as posed.
- Layers cannot be keyframed or resized on the stage yet; size and opacity are numbers in the Scene step.
- Phase 6 is not started: no offline install, no export presets.

`PLAN.md` has the full status, decisions and next steps for whoever continues the work.
