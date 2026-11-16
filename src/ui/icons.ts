// Small line drawings of the starting rigs. Drawn a few times, slightly offset, so they read as
// line-pattern illustrations on the black rig cards.
import type { RigKind } from '../model/rig';

const PATHS: Record<RigKind, string> = {
  human: '<circle cx="20" cy="8" r="4"/><path d="M20 12v13M12 17l8-2 8 2M14 36l6-11 6 11"/>',
  two: '<path d="M8 18c4-6 14-7 20-2l6 1-6 3c-2 6-12 7-17 3z"/><circle cx="28" cy="13" r="3.5"/><path d="M33 13l4 1M17 24l-2 12M22 24l2 12M13 36h4M22 36h4M8 18l-5-3"/>',
  four: '<path d="M9 16h20c3 0 4 3 4 6H8c-1-3-1-6 1-6z"/><circle cx="8" cy="12" r="4"/><path d="M4 10l1-4 3 3M11 22v12M15 22v12M27 22v12M31 22v12M33 18c3-2 4-6 3-9"/>',
};

export function rigDrawing(kind: RigKind): SVGSVGElement {
  const layers = [0, 1.2, 2.4, 3.6].map((d, i) =>
    `<g transform="translate(${d} ${d})" opacity="${1 - i * 0.2}">${PATHS[kind]}</g>`).join('');
  const t = document.createElement('template');
  t.innerHTML = `<svg viewBox="-4 -2 48 44" fill="none" stroke="currentColor" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${layers}</svg>`;
  return t.content.firstElementChild as SVGSVGElement;
}
