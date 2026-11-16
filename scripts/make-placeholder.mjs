// Generates the placeholder character, built to the art input contract:
//   char_<name> > front / side > arm_L, arm_R, leg_L, leg_R > pieces
// Live strokes, round joint ends centred on the pivot, hidden areas drawn in full.
// Writes one SVG per rig level plus the true pivots, so the importer's guesses can be checked.
//
//   node scripts/make-placeholder.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'placeholder');
const LINE = '#2a2238', W = 5;
const SKIN = '#f6c9a0', SHIRT = '#5aa9e6', PANTS = '#3d4a7a', SHOE = '#e4572e', HAIR = '#6b3f2a';
const f = (n) => Math.round(n * 100) / 100;

// --- shapes: each is { d, fill } ------------------------------------------
/** A limb segment: two circles joined by their outer tangents, so both ends are round. */
function capsule([x1, y1], r1, [x2, y2], r2, fill) {
  const d = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / d, uy = (y2 - y1) / d;
  const sin = (r1 - r2) / d, cos = Math.sqrt(1 - sin * sin);
  const n = (sign) => [ux * sin - sign * uy * cos, uy * sin + sign * ux * cos];
  const [ax, ay] = n(1), [bx, by] = n(-1);
  const P = (cx, cy, r, nx, ny) => `${f(cx + r * nx)} ${f(cy + r * ny)}`;
  return {
    fill,
    d: `M${P(x1, y1, r1, ax, ay)}L${P(x2, y2, r2, ax, ay)}A${r2} ${r2} 0 ${r2 > r1 ? 1 : 0} 0 ${P(x2, y2, r2, bx, by)}` +
       `L${P(x1, y1, r1, bx, by)}A${r1} ${r1} 0 ${r1 >= r2 ? 1 : 0} 0 ${P(x1, y1, r1, ax, ay)}Z`,
  };
}
const ellipse = (cx, cy, rx, ry, fill) => ({
  fill, d: `M${f(cx - rx)} ${f(cy)}A${rx} ${ry} 0 1 0 ${f(cx + rx)} ${f(cy)}A${rx} ${ry} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`,
});
const path = (d, fill) => ({ d, fill });

const shape = (s, extra = '') => `<path d="${s.d}" fill="${s.fill}" stroke="${LINE}" stroke-width="${W}" stroke-linejoin="round"${extra}/>`;

/** One piece from one shape, or several shapes merged the way artists do it:
 *  outlined shapes underneath, the same shapes without outlines on top. */
function piece(id, shapes, details = '') {
  if (shapes.length === 1) {
    return details ? `<g id="${id}">${shape(shapes[0])}${details}</g>` : shape(shapes[0], ` id="${id}"`);
  }
  const under = shapes.map((s) => `<path d="${s.d}" fill="${s.fill}" stroke="${LINE}" stroke-width="${W * 2}" stroke-linejoin="round"/>`);
  const over = shapes.map((s) => `<path d="${s.d}" fill="${s.fill}"/>`);
  return `<g id="${id}">${under.join('')}${over.join('')}${details}</g>`;
}

// --- one view ---------------------------------------------------------------
function buildView(view, ox) {
  // The 3/4 view is the front view turned toward the viewer's left: narrower, the far side tucked behind.
  const quarter = view === 'quarter', front = view === 'front' || quarter;
  const X = quarter ? (x) => f(ox + 300 + (x - 300) * 0.6 - 10) : (x) => x + ox;
  // Character's own left is on the viewer's right in the front view.
  // In the side view the character faces the viewer's left, so its left side is the near side.
  const J = front
    ? {
        neck: [300, 232], waist: [300, 446],
        shoulder_L: [362, 286], elbow_L: [378, 392], wrist_L: [386, 490],
        shoulder_R: [238, 286], elbow_R: [222, 392], wrist_R: [214, 490],
        hip_L: [330, 500], knee_L: [334, 640], ankle_L: [336, 770],
        hip_R: [270, 500], knee_R: [266, 640], ankle_R: [264, 770],
      }
    : {
        neck: [300, 232], waist: [300, 446],
        shoulder_L: [300, 286], elbow_L: [306, 392], wrist_L: [296, 490],
        shoulder_R: [310, 286], elbow_R: [316, 392], wrist_R: [306, 490],
        hip_L: [298, 500], knee_L: [296, 640], ankle_L: [302, 770],
        hip_R: [310, 500], knee_R: [308, 640], ankle_R: [314, 770],
      };
  for (const k of Object.keys(J)) J[k] = [X(J[k][0]), J[k][1]];

  const limb = (s) => {
    const sh = J[`shoulder_${s}`], el = J[`elbow_${s}`], wr = J[`wrist_${s}`];
    const hip = J[`hip_${s}`], kn = J[`knee_${s}`], an = J[`ankle_${s}`];
    const toe = quarter ? -12 : front ? (s === 'L' ? 8 : -8) : -16;
    return {
      upperarm: capsule(sh, 20, el, 16, SHIRT),
      forearm: capsule(el, 16, wr, 12, SKIN),
      hand: ellipse(wr[0] + (front ? 0 : -2), wr[1] + 12, 16, 17, SKIN),
      thigh: capsule(hip, 26, kn, 19, PANTS),
      shin: capsule(kn, 19, an, 14, SKIN),
      foot: ellipse(an[0] + toe, an[1] + 15, front ? 26 : 32, 16, SHOE),
    };
  };
  const L = limb('L'), R = limb('R');

  const chest = front
    ? path(`M${X(284)} 216L${X(316)} 216L${X(316)} 258L${X(350)} 262Q${X(374)} 264 ${X(374)} 290L${X(366)} 440Q${X(364)} 464 ${X(340)} 464L${X(260)} 464Q${X(236)} 464 ${X(234)} 440L${X(226)} 290Q${X(226)} 264 ${X(250)} 262L${X(284)} 258Z`, SHIRT)
    : path(`M${X(286)} 216L${X(314)} 216L${X(316)} 258Q${X(342)} 264 ${X(342)} 300L${X(338)} 440Q${X(336)} 464 ${X(316)} 464L${X(282)} 464Q${X(262)} 464 ${X(262)} 440L${X(258)} 300Q${X(258)} 264 ${X(284)} 258Z`, SHIRT);
  const pelvis = front
    ? path(`M${X(244)} 428L${X(356)} 428Q${X(364)} 428 ${X(364)} 438L${X(366)} 498Q${X(366)} 530 ${X(336)} 530L${X(264)} 530Q${X(234)} 530 ${X(234)} 498L${X(236)} 438Q${X(236)} 428 ${X(244)} 428Z`, PANTS)
    : path(`M${X(268)} 428L${X(332)} 428Q${X(340)} 428 ${X(340)} 438L${X(342)} 498Q${X(342)} 530 ${X(318)} 530L${X(282)} 530Q${X(258)} 530 ${X(258)} 498L${X(260)} 438Q${X(260)} 428 ${X(268)} 428Z`, PANTS);

  const hx = quarter ? 290 : front ? 300 : 294;
  const headShape = ellipse(X(hx), 160, quarter ? 56 : front ? 60 : 58, 68, SKIN);
  const eye = (x) => `<circle cx="${X(x)}" cy="166" r="5" fill="${LINE}"/>`;
  const face = front
    ? `<path d="M${X(238)} 150Q${X(240)} 84 ${X(300)} 84Q${X(360)} 84 ${X(362)} 150Q${X(330)} 118 ${X(300)} 122Q${X(270)} 118 ${X(238)} 150Z" fill="${HAIR}" stroke="${LINE}" stroke-width="${W}" stroke-linejoin="round"/>` +
      (quarter ? eye(256) + eye(296) : eye(278) + eye(322))
    : `<path d="M${X(262)} 108Q${X(290)} 78 ${X(326)} 92Q${X(360)} 110 ${X(354)} 176Q${X(330)} 150 ${X(318)} 116Q${X(290)} 120 ${X(262)} 108Z" fill="${HAIR}" stroke="${LINE}" stroke-width="${W}" stroke-linejoin="round"/>` +
      eye(262);
  const hairBack = quarter ? ellipse(X(316), 174, 62, 82, HAIR) : front ? ellipse(X(300), 176, 76, 84, HAIR) : ellipse(X(322), 172, 52, 80, HAIR);

  // The lip-sync set, every shape drawn at the same spot on the face.
  const mx = X(quarter ? 274 : front ? 300 : 256), my = 198, k = quarter ? 0.85 : front ? 1 : 0.7;
  const lip = `stroke="${LINE}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"`;
  const hole = (rx, ry, extra = '') => `<ellipse cx="${mx}" cy="${my}" rx="${f(rx * k)}" ry="${ry}" fill="#5a1e2c" ${lip}/>${extra}`;
  const mouths = {
    rest: `<path d="M${f(mx - 14 * k)} ${my - 2}Q${mx} ${my + 10} ${f(mx + 14 * k)} ${my - 2}" fill="none" ${lip}/>`,
    mbp: `<path d="M${f(mx - 11 * k)} ${my}L${f(mx + 11 * k)} ${my}" fill="none" ${lip}/>`,
    a: hole(11, 12),
    e: hole(15, 7, `<rect x="${f(mx - 9 * k)}" y="${my - 6}" width="${f(18 * k)}" height="4" fill="#fff"/>`),
    o: hole(7, 8),
    u: hole(4.5, 5),
    fv: `<path d="M${f(mx - 10 * k)} ${my}L${f(mx + 10 * k)} ${my}" fill="none" ${lip}/><rect x="${f(mx - 6 * k)}" y="${my}" width="${f(12 * k)}" height="4" fill="#fff" stroke="${LINE}" stroke-width="1.5"/>`,
    l: hole(10, 9, `<circle cx="${mx}" cy="${my + 3}" r="${f(5 * k)}" fill="#f08a8a"/>`),
  };

  const pivots = Object.fromEntries(Object.entries(J).map(([k2, v]) => [k2, { x: v[0], y: v[1] }]));
  return { front: front && !quarter, L, R, chest, pelvis, headShape, face, hairBack, pivots, mouths };
}

/** Pieces of one view at one rig level, bottom of the layer stack first. */
function viewMarkup(v, level, id) {
  const arm = (s) => {
    const p = v[s];
    if (level === 'low') return piece(id(`arm_${s}`), [p.forearm, p.hand, p.upperarm]);
    if (level === 'medium') return `<g id="${id(`arm_${s}`)}">${piece(id(`forearm_${s}`), [p.forearm, p.hand])}${piece(id(`upperarm_${s}`), [p.upperarm])}</g>`;
    return `<g id="${id(`arm_${s}`)}">${piece(id(`forearm_${s}`), [p.forearm])}${piece(id(`hand_${s}`), [p.hand])}${piece(id(`upperarm_${s}`), [p.upperarm])}</g>`;
  };
  const leg = (s) => {
    const p = v[s];
    if (level === 'low') return piece(id(`leg_${s}`), [p.shin, p.foot, p.thigh]);
    if (level === 'medium') return `<g id="${id(`leg_${s}`)}">${piece(id(`shin_${s}`), [p.shin, p.foot])}${piece(id(`thigh_${s}`), [p.thigh])}</g>`;
    return `<g id="${id(`leg_${s}`)}">${piece(id(`shin_${s}`), [p.shin])}${piece(id(`foot_${s}`), [p.foot])}${piece(id(`thigh_${s}`), [p.thigh])}</g>`;
  };
  const body = level === 'high'
    ? piece(id('pelvis'), [v.pelvis]) + piece(id('chest'), [v.chest])
    : piece(id('torso'), [v.pelvis, v.chest]);
  const head = piece(id('head'), [v.headShape], v.face) +
    `<g id="${id('mouths')}">${Object.entries(v.mouths).map(([n, m]) => `<g id="${id(`mouth_${n}`)}">${m}</g>`).join('')}</g>`;
  const hair = piece(id('hair_back'), [v.hairBack]);
  return v.front
    ? [hair, leg('R'), leg('L'), body, head, arm('R'), arm('L')]
    : [arm('R'), leg('R'), hair, leg('L'), body, head, arm('L')]; // far limbs go behind the body
}

mkdirSync(OUT, { recursive: true });
const front = buildView('front', 0), side = buildView('side', 600), quarter = buildView('quarter', 1200);
for (const level of ['low', 'medium', 'high']) {
  // Illustrator renames repeated layer names (head, head_1_); the importer strips that.
  const svg =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1800 860" width="1800" height="860">\n` +
    `<g id="char_placeholder_${level}">\n` +
    `<g id="front">\n${viewMarkup(front, level, (n) => n).join('\n')}\n</g>\n` +
    `<g id="side">\n${viewMarkup(side, level, (n) => `${n}_1_`).join('\n')}\n</g>\n` +
    `<g id="three_quarter">\n${viewMarkup(quarter, level, (n) => `${n}_2_`).join('\n')}\n</g>\n` +
    // Shared hands: one standard size, pointing down, wrist at the top edge. Used on either wrist, in every view.
    `<g id="hands">\n` +
    piece('hand_fist', [ellipse(1120, 134, 15, 14, SKIN)]) + '\n' +
    piece('hand_point', [ellipse(1160, 134, 14, 14, SKIN), capsule([1162, 140], 5.5, [1164, 172], 5, SKIN)]) + '\n' +
    `</g>\n` +
    `</g>\n</svg>\n`;
  writeFileSync(join(OUT, `char_placeholder_${level}.svg`), svg);
}

// Part-by-part version: one SVG per piece, each with the whole artboard so positions are kept.
mkdirSync(join(OUT, 'parts'), { recursive: true });
for (const [view, v, box] of [['front', front, '0 0 600 860'], ['side', side, '600 0 600 860']]) {
  const parts = { hair_back: piece('hair_back', [v.hairBack]), head: piece('head', [v.headShape], v.face), chest: piece('chest', [v.chest]), pelvis: piece('pelvis', [v.pelvis]) };
  for (const [n, m] of Object.entries(v.mouths)) parts[`mouth_${n}`] = m;
  for (const s of ['L', 'R']) for (const n of ['upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot']) parts[`${n}_${s}`] = piece(`${n}_${s}`, [v[s][n]]);
  for (const [name, markup] of Object.entries(parts)) {
    writeFileSync(join(OUT, 'parts', `${view === 'front' ? '' : 'side_'}${name}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" width="600" height="860">\n${markup}\n</svg>\n`);
  }
}
writeFileSync(join(OUT, 'pivots.json'), JSON.stringify({ front: front.pivots, side: side.pivots, quarter: quarter.pivots }, null, 2));
console.log('Wrote placeholder SVGs and pivots.json to', OUT);
