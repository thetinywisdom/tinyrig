# Rig Animation Tool — improvement plan

**Status:** proposal for the owner to approve. Owner builds it, one phase at a time.
**Inputs:** owner's answers (these win), Design Engineer's review (`design-engineer-review.md`), Film Director's scope, Blender Artist's and Product Owner's notes.

## Who it's for and what it does
- **For:** the owner first: a comics artist who draws in Procreate and Figma. After Effects is too complex for them and CapCut is too basic.
- **Job:** turn a storyboard into an animated scene, one scene at a time. Short clips up to scenes of about 2 minutes.
- **Promise:** free and open source forever. Simpler than paid rigging tools. Essentials only, and stays that way. Fast and light like CapCut. Works offline later.
- **The anchor:** the storyboard. Every scene starts as a grid of panels, and every feature has to tie back to a panel.
- **Rule for every future feature:** does it help get from a storyboard panel to a finished shot faster? If not, it waits.

## The one test for the whole plan
Make a 30-second, 5-shot dialogue between two characters at a desk, with a slow push-in and a phone-buzz sound effect. Export it without leaving the app or reading any docs. (This is Film Director's test.) Every phase below moves toward it.

---

## Phase 0: Make it possible to start (quick fixes, no new features)
The owner says the current flow is too strange to even begin. Fix that before building anything.
- Remove the 5-step wizard and the naming-rules wall from the first run. Only show the naming check when an imported character actually has a problem.
- Left-drag on a part poses it and never pans the canvas. Pan with Space+drag or the trackpad.
- Make pivots and thin limbs easier to grab: keep the 12px dots but give them a 24px grab area.
- Turn auto-recording on by default ("Auto-record poses"), and show "Pose saved · frame 48" each time.
- Esc closes popovers. Show "Saved ✓" in the top bar.
- Rename the jargon using the table in the Design Engineer's review (for example, Ease/Even/Hold becomes Smooth/Steady/Snap).
- Keep red for one main action per screen, and make links plain underlined text.
- Fix the 6 console errors. Remove the blank export preview, or fix it.

**Done when:** the owner can import one of their own characters, pose it on two frames and play it back, all in under 5 minutes and without getting stuck.

## Phase 1: Storyboard home
- The start screen offers **New scene** and **Open scene**. New scene opens a storyboard with 3 sample panels: panel 1 is finished, panels 2 and 3 are sketches. A "Clear sample" button removes them. The finished sample is posed and moving but doesn't need lip sync: a gesture or a head turn is enough.
- The storyboard is a wrapping grid of panels, read like a comic page. Each panel has just three things:
  - **Sketch**
  - **Notes:** one free-text field for everything else (dialogue, action, camera, sound). The panel shows the first few lines; click to edit and see it all.
  - **Duration:** shown next to the panel number (for example `#4 · 3.2s`). You type it in, and a scratch voice take can set it later.
- Nothing else on the panel. A panel whose shot is animated shows a frame from that shot instead of the sketch, which is enough to see progress at a glance.
- Drop many sketch files on the grid to get one panel per file, ordered by filename. Paste an image into a selected panel.
- Add panels with a `+` tile, or with `+` in the gap between two panels. Drag to reorder. Duplicate with Ctrl/⌘+D. Delete gives an Undo message instead of a confirm dialog.
- The header shows the scene name and total runtime (for example `1:48 · 27 shots`).
- A "show sketch" toggle brings back the original sketch on animated panels.

**Done when:** the owner can recreate one real storyboard from their Google Sheet or Figma file in this grid in about 10 minutes, and would rather plan the next scene here than in Sheets.

## Phase 2: Shot editor (click a panel to zoom in)
- Clicking a panel opens its shot: a filmstrip of all shots across the top, the stage in the middle, a 280px inspector on the right, and the timeline below. A ← button (or Ctrl/⌘+↑) goes back to the storyboard.
- The inspector shows whatever is selected: a part, a character, the camera, a sound clip, text, or the shot itself. It replaces "More options".
- One `+ Add` button for Character, Background image, Foreground image and Text. Anything already used in this scene is listed first, so it's easy to reuse.
- **Several characters and layers from day one:** a typical scene has 2–3 main characters, extra characters behind and in front of them, and background and foreground images.
  - Each shot is a simple stack of layers: background image, characters and extras in any order, then foreground image. Drag to change the order.
  - Extras can be added again and again from a scene list. An extra can stand still, or use one saved pose loop, so it never needs full animation.
  - Hide or lock a layer with one click, so posing a main character never grabs an extra by mistake.
- Rig editing becomes an "Edit rig" mode inside the inspector, replacing the Character step.
- Tidy the shortcuts: Space to play, `,` and `.` to step a frame, `[` and `]` for the previous and next shot, K to key, `?` for the shortcut list.

**Done when:** the owner can set up one real scene with 3 main characters, at least 2 extras and a front and back image, then block it in three shots by moving between the storyboard and the editor, without opening a menu to find a setting.

## Phase 3: Sound and mouths
- Scene-level sound: Voice, Sound effect and Music lanes on one timeline that keep playing across cuts. Animation stays inside each shot. The timeline has two zoom levels, Shot and Scene (`\` switches between them).
- A **Record scratch take** mic on each panel and in the editor. Recording a line sets that shot's length.
- Import voice, sound effects and music files. Include a small starter pack of sound effects (a phone buzz, a door, a few footsteps).
- **Mouth shapes stay manual for now:** keep today's row of mouth shapes under the Voice lane, where you click to set a shape. Automatic mouths are in Later.

**Done when:** the owner records three lines across three panels and the shot lengths follow. Sound plays across the cuts without gaps.

## Phase 4: Play and export the whole scene
- **Play animatic** in the storyboard header plays sketches and finished shots back to back, with sound.
- Transitions between panels: Cut by default, with Dissolve and Fade at a fixed 12-frame length.
- A camera tool: drag a frame box on the stage, set a start and an end with easing, and choose Shake (Off, Light or Strong).
- Safe-area guides, off by default, showing every export shape at once.
- Export the whole scene in 16:9 and 9:16, with a working preview.
- Save to and open from a project file (Ctrl/⌘+S), plus autosave in the browser.

**Done when:** the 30-second, 5-shot desk-dialogue test passes on the first try, and the owner re-opens the project file the next day and keeps working.

## Later (after the test passes and the owner has used it for real)
- **Automatic mouth shapes from the voice line.** The owner chose to leave this for later. When it's picked up, first check that a free engine (for example Rhubarb Lip Sync, MIT-licensed) runs offline and copes with a 2-minute scene.
- **Native apps** for iOS, Android, macOS and Windows. These come after the browser prototype.
Sound that gets quieter under dialogue (ducking), pasting a script to create panels, parallax backgrounds, freeze-frame effects, inserted screens (a phone screen, for example), and working fully offline as an installed app.

## Cut (don't build, and remove what already exists)
- The 5-step wizard
- Joystick and slider pose controllers
- Per-pose draw order
- Exact angle number fields
- Part-by-part import
- Rig levels (detect automatically instead)
- The 4:3 and 3:4 export shapes
- Lenses and depth of field
- Episodes with more than one scene in a project
- Any 4th transition type, and per-transition length controls in the first version

## Building for later platforms (without bloating the prototype)
The prototype is browser-only. Native apps for iOS, Android, macOS and Windows come later. Two cheap habits now will save a rewrite then:
- Size every grab area for touch: 24px minimum, and aim for 44px on anything you'd tap often.
- Keep the scene data (panels, shots, layers, poses, keys, sound) in one plain project file, separate from the screen code. Then a native app can open the same files later.
Nothing else for native goes into the prototype.

## Questions for the owner
Answered so far:
- Automatic mouths: later.
- Typical scene: 2–3 main characters, extras behind and in front, and background and foreground images.
- Platforms: browser first, native apps later.

- Storyboard panel: sketch, Notes (one free-text field) and Duration only.

Still open:
1. **Open source:** when do you want the code public? It affects which sound effects and other outside pieces we can include.
