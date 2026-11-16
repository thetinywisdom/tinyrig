# Rig Animation Tool

Act it out, and your drawn character copies you. A free, self-owned web app: static files only, no accounts,
no AI services. The only thing that ever goes online is a Google font, and only if you add one.

## Run it

```bash
npm install
npm run dev        # open the printed address in Chrome or Edge
```

```bash
npm run build      # static app in dist/
npm test           # unit tests
```

## How it works

1. **Characters.** Import a character drawn in Illustrator, Figma or Procreate, one part per layer. Drag each dot to
   where that part turns. Draw it from as many angles as you like: front, 3/4, side, back. For side and 3/4
   drawings, say which way the character looks.
2. **Storyboard.** Your scene as a grid of panels: a sketch, notes and a length each. Drop sketch files to make panels.
3. **Act it out.** Open a panel, take a photo with the webcam or choose photos of yourself. The app finds your body
   and puts dots on it; drag any that are off. Your character copies the pose, in the angle you stand at.
   Each photo is a pose; the app moves from one pose to the next. Set how long each pose holds, and press Play.
   **From the waist up works too** (a webcam at a desk): parts outside the photo keep the pose they had, and only
   the dots inside the photo are shown.

Also in a panel: **Background…**, **Flip**, the angle buttons, **Save as a pose** and **My poses** (any saved pose
fits any character).

## Art: naming

- `char_<name>` holds the angles `front`, `three_quarter` (or `quarter`, `3q`), `side`, `back`, which hold the parts:
  `head`, `chest`, `pelvis`, `upperarm_L`, `forearm_L`, `hand_L`, `thigh_L`, `shin_L`, `foot_L` and the `_R` ones.
- Procreate: one PSD per angle (`momo_front.psd`, `momo_3q.psd`), each part a `_line` layer over a `_fill` layer.
- The import screen lists the full naming rules when an import has a problem.

## Project folder

Everything saves to the browser as you work. The Project menu also saves to a real folder (Chrome, Edge) and
exports or opens a zip. All plain files: `characters/`, `poses/`, `storyboard.json`, `sketches/`, `photos/`,
`backgrounds/`.

`PLAN.md` has the status and next steps.
