// The first screen when there is no episode yet: start a new one, or open one you have.
import { h } from './dom';

export function mountStart(host: HTMLElement, opts: { onNew: () => void; onOpenFolder?: () => void; onOpenZip: () => void }) {
  host.replaceChildren(h('main', { class: 'start' },
    h('div', { class: 'start-card' },
      h('p', { class: 'start-eyebrow' }, 'Rig Animation Tool'),
      h('h1', {}, 'Turn a storyboard into an animated episode'),
      h('p', { class: 'meta' }, 'An episode starts as a storyboard of scenes. Sketch them, time them, then animate one scene at a time.'),
      h('div', { class: 'start-actions' },
        h('button', { class: 'primary', id: 'new-scene', onclick: opts.onNew }, 'New episode'),
        h('button', { id: 'open-scene', onclick: opts.onOpenFolder ?? opts.onOpenZip }, opts.onOpenFolder ? 'Open episode folder…' : 'Open episode…')),
      opts.onOpenFolder ? h('p', { class: 'meta' }, 'Saved it as a zip? ', h('button', { class: 'link', id: 'open-zip', onclick: opts.onOpenZip }, 'Open a zip')) : null,
      h('p', { class: 'meta start-note' }, 'New episodes start with a short sample you can clear in one click.'))));
}
