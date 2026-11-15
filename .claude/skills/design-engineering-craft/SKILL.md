---
name: design-engineering-craft
description: >-
  Use this first for any motion, gesture, interaction-polish, or 'make it feel
  great' work on web, React Native, or SwiftUI: it holds the shared rules from
  Emil Kowalski's skills (exact easing, durations, springs, what never animates)
  and routes to the right specialist skill for the job.
---
# Design engineering craft (umbrella)

One entry point for the Emil Kowalski skill set: `emil-design-eng`, `animate`, `animate-expo`, `review-animations`, `improve-animations`, `find-animation-opportunities`, `remove-animations`, `choreograph`, `animation-performance`, `animation-vocabulary`, `apple-design`, `gestures`, `pick-ui-library`, `prototype`, `mobile-native`, `break-ui`, `learn-taste`, `write-swift`.

Use it two ways: (1) apply the shared rules below directly for small questions, (2) route to the specialist skill and load it by name with the Skill tool for real work. Never paraphrase a specialist skill from memory when the job is squarely its own.

## Step 1. Route the job

| The ask | Load |
| --- | --- |
| Build a new animation or transition (web) | `animate` |
| Same, in React Native / Expo | `animate-expo` |
| Several things moving together: stagger, hero entrance, view swap, multi-step | `choreograph` |
| Drag, swipe, fling, sheet, snap points, pull-to-refresh, hold-to-confirm | `gestures` (plus `apple-design` for the physics) |
| Apple-style feel, springs, materials, momentum, iOS/SwiftUI motion | `apple-design` |
| Review a diff or a component's motion strictly | `review-animations` |
| Audit all motion in a codebase and plan fixes | `improve-animations` |
| "What could animate here?" | `find-animation-opportunities` |
| "Feels slow / over-animated" | `remove-animations` |
| Janky, dropped frames, will-change, CSS vs JS | `animation-performance` |
| "What's that effect called?" | `animation-vocabulary` |
| Component polish: press states, popover origin, tooltips, clip-path | `emil-design-eng` |
| Web app feels wrong on a phone, PWA, safe areas, 100vh | `mobile-native` |
| Which library for toasts, drawers, cmdk, charts, DnD, state | `pick-ui-library` |
| Try several genuinely different versions of a UI piece | `prototype` |
| Stress-test a UI with worst-case data | `break-ui` |
| Turn this session's design corrections into lasting rules | `learn-taste` |
| Writing or reviewing Swift code itself | `write-swift` |

A full screen or app review still starts with `better-interface`; pull motion findings from here into its ranked report.

## Step 2. The order of decisions (every motion question)

1. **Should it move at all?** By frequency: 100+ times a day (keyboard shortcuts, command palette) never animates; tens of times a day (hover, list navigation) barely; occasional (modals, drawers, toasts) gets standard motion; rare or first-time (onboarding, celebrations) can delight. Never animate keyboard-initiated actions.
2. **What is it for?** Only spatial consistency, state change, explanation, feedback, or avoiding a jarring jump. "Looks cool" on something seen often is not a reason.
3. **Which tool?** Cheapest that works: CSS transition, then WAAPI, then Motion. Transitions over keyframes for anything that can be retriggered, because transitions retarget and keyframes restart.
4. **Which properties?** `transform` and `opacity` only. Never `transition: all`. Never animate width, height, margin, or padding for UI.
5. **Curve and duration, or a spring?** See the values below. Anything the user touches or can interrupt gets a spring.
6. **Interruption and exit.** It must reverse smoothly mid-motion. Exit faster than enter.
7. **Reduced motion and pointer.** Reduced motion means gentler, not none: keep opacity and color, drop movement. Gate hover effects behind `@media (hover: hover) and (pointer: fine)`.

## Step 3. The values

**Curves** (never `ease-in` on UI):
```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);      /* enter, exit, most UI */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);  /* moving or morphing on screen */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);   /* iOS-like sheets and drawers */
```
Hover and color changes use `ease`; constant motion (progress, marquee) uses `linear`.

**Durations:** press feedback 100–160ms, tooltips and small popovers 125–200ms, dropdowns 150–250ms, modals and drawers 200–500ms. UI stays under 300ms except modals, drawers, sheets, and toasts.

**Springs:** default critically damped, no bounce (Motion `{ type: 'spring', bounce: 0, duration: 0.4 }`). Add bounce 0.1–0.3 only when a gesture carried momentum (a flick or drag release); a button-triggered close gets zero bounce. Apple's shipped values: move damping 1.0 / response 0.4, rotation 0.8 / 0.4, sheet 0.8 / 0.3. Hand the finger's release velocity to the spring.

**Physical details:** never scale from 0, start at 0.95 with opacity 0. Popovers grow from their trigger (modals stay centered). Pressables scale to 0.97 on press. Tooltips: delay the first, show the rest instantly. Stagger 30–80ms, non-uniform, never blocking input. A crossfade that still looks off gets a 2px blur during the swap. Hold-to-confirm is slow in (about 2s linear) and fast out (200ms ease-out).

**Gestures:** track the finger 1:1 with no easing during the drag. Dismiss on velocity (about 0.11 px/ms) as well as distance. Rubber-band past edges instead of hard stops. Capture the pointer, ignore extra touches mid-drag, and keep everything catchable mid-animation.

## Step 4. SwiftUI translation (for native iOS work)

The specialist skills are mostly web; carry the same rules over like this:
- Springs: `.spring(response: 0.4, dampingFraction: 1.0)` as the default; `.spring(duration: 0.4, bounce: 0)` on iOS 17+. Momentum releases get `dampingFraction: 0.8` or `bounce: 0.2`. `.smooth` is the no-bounce built-in; `.snappy` and `.bouncy` carry a little bounce, so use them only where a bounce is earned.
- Curves: `.timingCurve(0.23, 1, 0.32, 1, duration: 0.2)` is the strong ease-out.
- Press feedback: a custom `ButtonStyle` with `scaleEffect(configuration.isPressed ? 0.97 : 1)` and a quick animation.
- Never-animate cases (scrubbing, keyboard shortcuts, frame stepping): wrap the state change in a `Transaction` with `disablesAnimations = true`, or set `.animation(nil, value:)`.
- Gestures: drive the offset straight from `DragGesture` translation, then on end animate with a spring seeded by `predictedEndTranslation` / velocity. Prefer native `.sheet` with `presentationDetents` before building a custom sheet.
- Reduced motion: read `@Environment(\.accessibilityReduceMotion)` and swap movement for opacity.
- Haptics: `.sensoryFeedback` (iOS 17+) only on meaningful moments: success, error, commit, snap.
- Start the `withAnimation` change synchronously in the gesture or tap callback, and put slow work in a `Task` after (see `write-swift`).

## Step 5. How to report

- Reviews use one table with Before | After | Why columns, ranked by impact, with exact values.
- Say plainly when feel can't be judged from code or a screenshot, and add a feel-check step: slow the animation 2–5x, step frame by frame, or try it on a real device for gestures.
- Never claim a frame rate, duration, or size you didn't measure; mark it Not verified.
- When the motion is already right, say so. A short, sure list beats a padded one.
