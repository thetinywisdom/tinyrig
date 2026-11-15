/**
 * Small, shared interaction behaviour, following the design-engineering-craft skill
 * (.claude/skills/design-engineering-craft/SKILL.md):
 *
 * - Only occasional things move: popovers and the side panel. The stage, the timeline, frame stepping
 *   and anything started from the keyboard never animate, because they are used hundreds of times a day.
 * - Motion uses transform and opacity only, with a strong ease-out, and never starts from scale 0.
 * - Popovers grow from the button that opened them. Closing is instant (exit faster than enter).
 * - Reduced motion keeps the fade and drops the movement.
 */

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
export const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Fade and grow an element in. Pass `from` as the CSS transform to start at. */
export function enter(el: HTMLElement, from: string, duration: number, easing = EASE_OUT) {
  if (!el.animate) return;
  el.animate(
    [{ opacity: 0, transform: reduced() ? 'none' : from }, { opacity: 1, transform: 'none' }],
    { duration: reduced() ? Math.min(duration, 150) : duration, easing },
  );
}

const POPOVERS = 'details.menu, details.more';

/**
 * Popovers (`details.menu`) and folded groups (`details.more`):
 * - opening one with a mouse click grows it in; opening with the keyboard, or the app re-drawing an
 *   open one, shows it at once;
 * - Escape closes the open menus and puts focus back on the button that opened them;
 * - a click outside an open menu closes it.
 * Install once for the page.
 */
export function installPopovers() {
  // A real mouse click on a summary marks its details to animate when the toggle lands.
  document.addEventListener('click', (e) => {
    const summary = (e.target as Element).closest?.('summary');
    const details = summary?.parentElement;
    if (details?.matches(POPOVERS) && e.detail > 0) details.dataset.clicked = '1';
  }, true);

  // `toggle` does not bubble, so listen in the capture phase.
  document.addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement;
    if (!(d instanceof HTMLDetailsElement) || !d.matches(POPOVERS)) return;
    const clicked = d.dataset.clicked === '1';
    delete d.dataset.clicked;
    if (!d.open || !clicked) return;
    if (d.matches('.menu')) {
      // Only one menu open at a time.
      document.querySelectorAll<HTMLDetailsElement>('details.menu[open]').forEach((o) => { if (o !== d) o.open = false; });
      const items = d.querySelector<HTMLElement>('.menu-items');
      if (items) enter(items, 'scale(0.95)', 160);
    } else {
      const body = d.querySelector<HTMLElement>('.more-body');
      if (body) enter(body, 'translateY(-4px)', 180);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll<HTMLDetailsElement>('details.menu[open]')];
    if (!open.length) return;
    e.preventDefault();
    const back = open.find((d) => d.contains(document.activeElement));
    open.forEach((d) => { d.open = false; });
    (back ?? open[0]).querySelector('summary')?.focus();
  });

  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Element;
    document.querySelectorAll<HTMLDetailsElement>('details.menu[open]').forEach((d) => {
      if (!d.contains(target)) d.open = false;
    });
  });
}
