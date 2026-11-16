// Importer screen: open a file (whole character or part by part), confirm the
// rig level, read the check report. Also shows the naming convention.
import { buildRig, levelIssues } from '../import/build';
import { importPsd } from '../import/psd';
import { importSvg, importSvgParts } from '../import/svg';
import { parsePartFileName, type RigLevel } from '../model/skeleton';
import type { ImportResult, Issue, Rig } from '../model/types';
import { h } from './dom';
import { RIG_KIND_LABEL } from '../model/rig';

export interface Imported { imp: ImportResult; rig: Rig; issues: Issue[] }
export type ImportMode = 'whole' | 'parts';
type InFile = { name: string; data: ArrayBuffer };

const LEVEL_CARDS: Record<RigLevel, { title: string; bends: string }> = {
  low: { title: 'Simple', bends: 'Bends at the neck, shoulders and hips' },
  medium: { title: 'Medium', bends: 'Bends at the neck, shoulders, elbows, hips and knees' },
  high: { title: 'Complex', bends: 'Bends at every joint, including waist, wrists and ankles' },
};

const PLACEHOLDERS: { label: string; mode: ImportMode; files: string[] }[] = [
  { label: 'High', mode: 'whole', files: ['char_placeholder_high.svg'] },
  { label: 'Medium', mode: 'whole', files: ['char_placeholder_medium.svg'] },
  { label: 'Low', mode: 'whole', files: ['char_placeholder_low.svg'] },
  { label: 'PSD (Procreate style)', mode: 'whole', files: ['char_placeholder_front.psd', 'char_placeholder_side.psd'] },
];

/** Dropped files: several SVGs, or one SVG named after a piece, are part files. */
export function guessMode(files: InFile[]): ImportMode {
  const svgs = files.filter((f) => /\.svg$/i.test(f.name));
  if (files.some((f) => /\.psd$/i.test(f.name))) return 'whole';
  return svgs.length > 1 || (svgs.length === 1 && !!parsePartFileName(svgs[0].name).piece) ? 'parts' : 'whole';
}

export async function readFiles(
  files: InFile[], mode: ImportMode, wanted: string | undefined, onProgress: (done: number, total: number) => void,
): Promise<Imported> {
  const psds = files.filter((f) => /\.psd$/i.test(f.name));
  const svgs = files.filter((f) => /\.svg$/i.test(f.name));
  const text = (f: InFile) => new TextDecoder().decode(f.data);
  let imp: ImportResult;
  if (mode === 'parts') {
    if (!svgs.length) throw new Error('Part-by-part import takes SVG files, one per piece.');
    imp = await importSvgParts(svgs.map((f) => ({ name: f.name, text: text(f) })), onProgress);
  } else if (psds.length) imp = await importPsd(psds, onProgress);
  else if (svgs.length) {
    imp = await importSvg(text(svgs[0]), svgs[0].name, wanted, onProgress);
    if (svgs.length > 1) {
      imp.issues.push({ severity: 'warn', text: `Only ${svgs[0].name} was read. Put every piece in one SVG as named layers.` });
    }
  } else throw new Error('Choose an SVG file, or the PSD files of one character.');
  const { rig, issues } = buildRig(imp);
  return { imp, rig, issues: [...imp.issues, ...issues] };
}

export function issueList(issues: Issue[]): HTMLElement {
  if (!issues.length) return h('p', { class: 'ok' }, 'No problems found.');
  const order = { error: 0, warn: 1, info: 2 };
  return h('ul', { class: 'issues' },
    [...issues].sort((a, b) => order[a.severity] - order[b.severity]).map((i) =>
      h('li', { class: i.severity }, h('span', { class: 'tag' }, i.severity === 'warn' ? 'Check' : i.severity === 'error' ? 'Problem' : 'Note'), i.text)),
  );
}

const code = (...names: string[]) => names.flatMap((n, i) => [i ? ' ' : '', h('code', {}, n)]);

function namingConvention(): HTMLElement {
  const row = (what: string, names: (string | Node)[], note: string) => h('tr', {}, h('th', { scope: 'row' }, what), h('td', {}, names), h('td', {}, note));
  return h('details', { class: 'naming', id: 'naming' },
    h('summary', {}, 'How to name your layers and files'),
    h('p', { class: 'meta' }, 'The importer finds everything by name, so groups and folders are optional. Capitals do not matter. Use English or romaji only: Japanese names become unreadable codes in SVG.'),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'What'), h('th', {}, 'Name'), h('th', {}, 'Notes'))),
      h('tbody', {},
        row('Character', code('char_<name>'), 'One layer per character, for example char_momo.'),
        row('View', code('front', 'side', 'back'), 'Same piece names in every view. Leave out pieces a view does not show.'),
        row('Limb group', code('arm_L', 'arm_R', 'leg_L', 'leg_R'), 'Optional groups that hold the limb pieces.'),
        row('Low pieces', code('head', 'torso', 'arm_L', 'arm_R', 'leg_L', 'leg_R'), 'Hands and feet drawn in. Bends: neck, shoulders, hips.'),
        row('Medium pieces', code('head', 'torso', 'upperarm_L', 'forearm_L', 'thigh_L', 'shin_L'), 'And the same four with _R. Adds elbows and knees.'),
        row('High pieces', code('head', 'chest', 'pelvis', 'upperarm_L', 'forearm_L', 'hand_L', 'thigh_L', 'shin_L', 'foot_L'), 'And the same six with _R. Adds waist, wrists and ankles.'),
        row('Optional', code('hair_back'), 'Hair behind the body. Follows the head.'),
        row('Left and right', code('_L', '_R'), "The character's own left and right, not yours."),
        row('Procreate layers', code('forearm_L_line', 'forearm_L_fill'), 'Each piece is a _line layer over a _fill layer. One PSD per view: momo_front.psd, momo_side.psd.'),
        row('Part files', code('head.svg', 'forearm_L.svg', 'side_head.svg', 'momo_side_head.svg'), 'One file per piece. Add the view before the piece name; no view means front. A character name in front is optional.'),
        row('Mouths, eyes, hair', code('mouth_rest', 'mouth_a', 'eyes_closed', 'hair_wet'), 'Extra layers on the head, drawn in place; one of each kind shows at a time. Lip sync uses mouth_rest, mouth_mbp, mouth_a, mouth_e, mouth_o, mouth_u, mouth_fv, mouth_l.'),
        row('Piece variants', code('forearm_L_bent', 'head_angry', 'hand_L_fist'), 'A second drawing of a piece, in the same place. Named after the piece it replaces.'),
        row('Shared hands', code('hand_fist', 'hand_point'), 'No side in the name. Draw once, pointing down with the wrist at the top edge; the app puts it on either wrist.'),
      )),
    h('p', { class: 'meta' }, 'Copies made by the app are understood: head_1_ (Illustrator), head_2 (Figma) and head-2 all read as head.'),
  );
}

export function mountImporter(
  host: HTMLElement, onDone: (result: Imported, files: InFile[], mode: ImportMode) => void, onCancel?: () => void,
) {
  let files: InFile[] = [];
  let mode: ImportMode = 'whole';
  let current: Imported | null = null;

  const status = h('p', { class: 'status', role: 'status' });
  // The naming guide shows only when an import has a problem it would help with.
  const naming = h('div', { class: 'naming-slot' });
  const showNaming = (show: boolean) => naming.replaceChildren(...(show ? [namingConvention()] : []));
  const review = h('div', { class: 'review' });
  const toFiles = (list: FileList | null | undefined) =>
    Promise.all([...(list ?? [])].map(async (f) => ({ name: f.name, data: await f.arrayBuffer() })));
  const picker = (m: ImportMode, accept: string) => {
    const input = h('input', {
      type: 'file', accept, multiple: true, hidden: true,
      onchange: async () => {
        const picked = await toFiles(input.files);
        input.value = '';
        if (picked.length) run(picked, m);
      },
    });
    return input;
  };
  const wholeInput = picker('whole', '.svg,.psd');

  async function run(next: InFile[], nextMode: ImportMode, wanted?: string) {
    files = next;
    mode = nextMode;
    review.replaceChildren();
    showNaming(false);
    status.className = 'status';
    status.textContent = 'Reading…';
    try {
      current = await readFiles(files, mode, wanted, (done, total) => { status.textContent = `Rendering pieces… ${done} of ${total}`; });
      status.textContent = '';
      showReview();
    } catch (err) {
      current = null;
      status.className = 'status error';
      status.textContent = err instanceof Error ? err.message : String(err);
      showNaming(true);
    }
  }

  function showReview() {
    const { imp, rig, issues } = current!;
    const views = Object.entries(imp.views).map(([v, p]) => `${v} (${p!.length} pieces)`).join(', ');
    const fileText = imp.fileNames.length > 3 ? `${imp.fileNames.length} files` : imp.fileNames.join(', ');
    const level = LEVEL_CARDS[rig.level];
    // A rig of its own (a creature) has no human parts to check for.
    const found = [...(rig.nodes ? [] : levelIssues(rig, rig.level)), ...issues];
    showNaming(found.some((i) => i.severity === 'error' || i.severity === 'warn'));

    review.replaceChildren(...[
      h('h2', {}, imp.name),
      h('p', { class: 'meta' }, `${mode === 'parts' ? 'Part by part' : 'Whole character'} · ${fileText} · views: ${views}`),
      imp.otherCharacters.length
        ? h('p', { class: 'meta' }, 'Also in this file: ',
            imp.otherCharacters.map((n) => h('button', { class: 'link', onclick: () => run(files, mode, n) }, n)))
        : null,
      rig.nodes
        ? h('p', { class: 'level' }, h('strong', {}, `${RIG_KIND_LABEL[rig.kind ?? 'four']} rig. `), 'Layers named like a node move with it. Check the nodes in Characters.')
        : h('p', { class: 'level' }, h('strong', {}, `${level.title} rig. `), `${level.bends}. Worked out from the pieces found.`),
      h('h3', {}, 'Check report'),
      issueList(found),
      h('button', { class: 'primary', id: 'open-editor', onclick: () => onDone(current!, files, mode) }, 'Open in editor'),
    ].filter((n) => n !== null));
    review.scrollIntoView({ block: 'nearest' });
  }

  const loadPlaceholder = async (p: (typeof PLACEHOLDERS)[number]) => {
    status.className = 'status';
    status.textContent = 'Loading…';
    try {
      const loaded = await Promise.all(p.files.map(async (path) => {
        const res = await fetch(`placeholder/${path}`);
        if (!res.ok) throw new Error(`placeholder/${path} is not available here.`);
        return { name: path.split('/').pop()!, data: await res.arrayBuffer() };
      }));
      await run(loaded, p.mode);
    } catch (err) {
      status.className = 'status error';
      status.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  const drop = h('div', {
    class: 'drop',
    ondragover: (e: DragEvent) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: async (e: DragEvent) => {
      e.preventDefault();
      drop.classList.remove('over');
      const dropped = await toFiles(e.dataTransfer?.files);
      if (dropped.length) run(dropped, guessMode(dropped));
    },
  },
    // Part-by-part import is cut in the owner's plan: one SVG, or one PSD per view. (Projects imported part by part still open.)
    h('div', { class: 'mode single' },
      h('h3', {}, 'Your character'),
      h('p', {}, 'One SVG that holds every piece as a named layer. From Procreate: one PSD per view.'),
      h('button', { class: 'primary', id: 'choose-whole', onclick: () => wholeInput.click() }, 'Choose file…')),
    h('p', { class: 'meta' }, 'Or drop files anywhere in this box. No art yet? Open the placeholder character: ',
      PLACEHOLDERS.map((p) => h('button', { class: 'link', 'data-placeholder': p.label, onclick: () => loadPlaceholder(p) }, p.label))),
  );

  host.replaceChildren(h('main', { class: 'importer' },
    onCancel ? h('button', { class: 'link', id: 'back', onclick: onCancel }, '← Back to the editor') : null,
    h('h1', {}, 'Import a character'), drop, wholeInput, status, review, naming));
}
