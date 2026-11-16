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

1. **Cast.** Import a character drawn in Illustrator, Figma or Procreate, one part per layer, and rig it: named nodes
   ("L hand", "Tail"), Human / 2 legs / 4 legs, Simple / Medium / Complex. Draw as many angles as you like.
2. **Storyboard.** Your story as a grid of scenes, each with a sketch and notes. Pick the project size once
   (Reels, Full HD, Square, 4:5 or your own); every scene is exported in that shape.
3. **Open a scene.** Two tabs:
   - **Rig**: who is in this scene. Change a rig here and only this scene changes, until you **Save to shared**.
   - **Animate**: act each character's poses out from photos or the webcam; the character copies you. Add images
     as layers (a sky, a room, leaves in front) and drag lanes to change what is in front. The **camera** is a frame
     on an endless canvas: add keys, and it moves or cuts between them. Only what is inside the frame is exported.
     **From the waist up works too**: parts outside the photo keep the pose they had.

## Art: naming

- `char_<name>` holds the angles `front`, `three_quarter` (or `quarter`, `3q`), `side`, `back`, which hold the parts:
  `head`, `chest`, `pelvis`, `upperarm_L`, `forearm_L`, `hand_L`, `thigh_L`, `shin_L`, `foot_L` and the `_R` ones.
- Procreate: one PSD per angle (`momo_front.psd`, `momo_3q.psd`), each part a `_line` layer over a `_fill` layer.
- Any other name is a part of your own (`tail`, `ear_L`, `front_leg_L`). Name a node the same, and it moves that layer.
  Spaces, order and capitals do not matter: `front_leg_L`, "L front leg" and "Left Front Leg" are one name.
- The import screen lists the full naming rules when an import has a problem.

## Project folder

Everything saves to the browser as you work. The Project menu also saves to a real folder (Chrome, Edge) and
exports or opens a zip. All plain files: `characters/`, `poses/`, `storyboard.json`, `sketches/`, `photos/`,
`backgrounds/`.

`PLAN.md` has the status and next steps.
