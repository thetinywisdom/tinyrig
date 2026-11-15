// End-to-end check in a real browser. Needs `npm run dev` running.
//   node scripts/check.mjs [outDir] [section...]     sections: storyboard import pose animate scene sound layers capture export save
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const out = process.argv[2] ?? 'check-output';
const only = process.argv.slice(3);
const want = (s) => !only.length || only.includes(s);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
let fail = 0;
const ok = (name, cond, extra = '') => { if (!cond) fail++; console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra); };
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;

async function open(placeholder = 'High') {
  // A fresh browser profile: the app reopens the last project otherwise.
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (m) => m.type() === 'error' && !/^INFO:/.test(m.text()) && errors.push(m.text()));
  await page.goto(APP);
  // Start screen → new scene → clear the sample → import a character into a new panel.
  await page.click('#new-scene');
  await page.waitForSelector('.sb-panel', { timeout: 30000 });
  await page.click('#clear-sample');
  await page.click('#sb-import');
  await page.click(`[data-placeholder="${placeholder}"]`);
  await page.waitForSelector('#open-editor, .status.error', { timeout: 90000 });
  return { context, page };
}
const settle = (page) => page.waitForFunction(() => window.__rig?.timeline, null, { timeout: 20000 }).then(() => page.waitForTimeout(350));
/** Wait for the editor, then open the panel and every folded group so the checks can reach all controls. */
const ready = async (page) => {
  await settle(page);
  await page.evaluate(() => { const ed = window.__rig; ed.openAll = true; ed.timeline.moreOpen = true; if (ed.shot.actors[0]) ed.select('actor', ed.shot.actors[0].id); ed.refresh(); });
  await page.waitForTimeout(150);
};
/** Show a character in the inspector, as clicking it on the stage does. */
const pickActor = (page, i = 0) => page.evaluate((n) => { const ed = window.__rig; ed.setMode('pose', false); ed.select('actor', ed.shot.actors[n].id); ed.evaluateAll(); ed.refresh(); }, i);
const addMenu = async (page, id) => { await page.click('#add summary'); await page.click(id); };
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const angles = (page) => ev(page, () => Object.fromEntries(Object.entries(window.__rig.pose().angles).map(([k, v]) => [k, Math.round(v)])));
const setAngles = (page, a) => ev(page, (a) => { const ed = window.__rig; Object.assign(ed.pose().angles, a); ed.edited(); ed.refresh(); }, a);
const stageBox = (page) => page.locator('.stage canvas').boundingBox();
/** Screen position of a rest-pose point on a bone of the selected character. */
const at = (page, bone, pt) => ev(page, ([b, p]) => {
  const ed = window.__rig, a = ed.sel(), m = ed.stage.actor({ id: a.id, rig: ed.rig() }).mats[b];
  return ed.stage.worldToScreen({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
}, [bone, pt]);
async function drag(page, from, dx, dy, mods = []) {
  const box = await stageBox(page);
  for (const k of mods) await page.keyboard.down(k);
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + from.x + dx / 2, box.y + from.y + dy / 2, { steps: 5 });
  await page.mouse.move(box.x + from.x + dx, box.y + from.y + dy, { steps: 5 });
  await page.mouse.up();
  for (const k of mods) await page.keyboard.up(k);
}
/** A file chooser opened by a button, answered with a file. */
async function choose(page, selector, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await chooser.setFiles(file);
}
/** A short "speech-like" WAV: bursts of tone with gaps. */
function wav(seconds, bursts) {
  const rate = 22050, n = Math.round(seconds * rate), data = Buffer.alloc(44 + n * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + n * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate, b = bursts.find(([a, z]) => t >= a && t < z);
    const v = b ? Math.sin(2 * Math.PI * 220 * t) * b[2] * (0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * t)) : 0;
    data.writeInt16LE(Math.round(v * 30000), 44 + i * 2);
  }
  return data;
}

// --- storyboard: start screen, sample, panels, undo, reorder, sketches, shot round trip ---
if (want('storyboard')) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (m) => m.type() === 'error' && !/^INFO:/.test(m.text()) && errors.push(m.text()));
  await page.goto(APP);
  ok('a first visit shows New scene and Open scene', await page.locator('#new-scene').isVisible() && await page.locator('#open-scene').isVisible());
  ok('no naming rules on the first screen', await page.locator('#naming').count() === 0);
  await page.click('#new-scene');
  await page.waitForSelector('.sb-panel');
  const ids = () => page.$$eval('.sb-panel', (n) => n.map((e) => e.dataset.id));
  const sb = (fn, arg) => page.evaluate(fn, arg);
  ok('a new scene has 3 sample panels', (await ids()).length === 3);
  ok('the header shows runtime and shot count', (await page.textContent('#sb-summary')) === '0:08 · 3 shots', await page.textContent('#sb-summary'));
  await page.waitForFunction(() => document.querySelector('.sb-panel img')?.src.startsWith('data:image/jpeg'), null, { timeout: 15000 });
  ok('the finished sample panel shows a frame of its shot', true);
  ok('the sample shot moves', await sb(() => { const s = window.__sb.ctx.project.shots[0]; return s.actors[0].keys.length >= 3; }));
  ok('sketch panels show their sketch', await page.locator('.sb-panel >> nth=1 >> img[alt^="Sketch"]').count() === 1);
  await page.screenshot({ path: `${out}/storyboard.png` });

  // Duration typed in; notes edited in place.
  await page.click('.sb-panel >> nth=1 >> .sb-dur');
  await page.fill('.sb-dur-input', '3.2');
  await page.keyboard.press('Enter');
  ok('a typed duration shows next to the panel number', (await page.textContent('.sb-panel >> nth=1 >> .sb-head')).includes('3.2s'));
  ok('runtime follows', (await page.textContent('#sb-summary')).startsWith('0:07'));
  await page.click('.sb-panel >> nth=2 >> .sb-notes');
  await page.fill('.sb-notes-edit', 'Close-up: phone.\nSound: buzz, twice.\nB looks over.\nA grabs it.');
  await page.click('#scene-name');
  ok('notes are saved and clamped to a few lines', await sb(() => window.__sb.sb.panels.some((p) => p.notes.endsWith('A grabs it.'))));

  // Add, duplicate, delete with Undo, reorder by dragging.
  await page.click('#sb-add');
  ok('Add panel adds one at the end and selects it', (await ids()).length === 4 && await page.locator('.sb-panel.selected').count() === 1);
  await page.hover('.sb-panel >> nth=1');
  await page.click('.sb-panel >> nth=1 >> .sb-gap');
  ok('+ in a gap adds a panel there', (await ids()).length === 5 && await sb(() => !window.__sb.sb.panels[1].notes));
  await page.click('.sb-panel >> nth=0 >> .sb-head');
  await page.keyboard.press('Control+d');
  ok('Ctrl+D duplicates the selected panel next to it', (await ids()).length === 6 && await sb(() => window.__sb.sb.panels[1].notes === window.__sb.sb.panels[0].notes && !window.__sb.sb.panels[1].shot));
  const before = await ids();
  await page.keyboard.press('Delete');
  ok('Delete removes the panel with an Undo message', (await ids()).length === 5 && /deleted/.test(await page.textContent('.toast')));
  await page.click('#toast-undo');
  ok('Undo brings it back', (await ids()).join() === before.join());
  const box = async (i) => page.locator(`.sb-panel >> nth=${i}`).boundingBox();
  const a = await box(0), c = await box(2);
  await page.mouse.move(a.x + a.width / 2, a.y + 30);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 40, a.y + 40, { steps: 4 });
  await page.mouse.move(c.x + c.width * 0.8, c.y + c.height / 2, { steps: 8 });
  ok('dragging marks where the panel will land', await page.locator('.drop-after, .drop-before').count() === 1);
  await page.mouse.up();
  const after = await ids();
  ok('dropping reorders the panels', after[2] === before[0] && after.length === before.length, JSON.stringify({ before, after }));
  await page.keyboard.press('Control+z');
  ok('undo puts the order back', (await ids()).join() === before.join());

  // Sketch files: one per new panel, in filename order.
  const png = (color) => sb((col) => new Promise((res) => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180; const g = cv.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 320, 180);
    cv.toBlob(async (bl) => res([...new Uint8Array(await bl.arrayBuffer())]));
  }), color);
  for (const [n, col] of [['shot10.png', '#f88'], ['shot2.png', '#8f8'], ['shot1.png', '#88f']]) writeFileSync(`${out}/${n}`, Buffer.from(await png(col)));
  const count = (await ids()).length;
  await page.evaluate(() => { window.__sb.selected = null; window.__sb.render(); });
  const dt = await page.evaluateHandle(async (files) => {
    const d = new DataTransfer();
    for (const [name, bytes] of files) d.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
    return d;
  }, await Promise.all(['shot10.png', 'shot2.png', 'shot1.png'].map(async (n) => [n, [...(await import('node:fs')).readFileSync(`${out}/${n}`)]])));
  await page.dispatchEvent('.sb-grid', 'drop', { dataTransfer: dt });
  await page.waitForTimeout(300);
  ok('dropped sketches become panels in filename order', await sb(() => window.__sb.sb.panels.slice(-3).map((p) => p.sketch).join()) === 'shot1.png,shot2.png,shot10.png' && (await ids()).length === count + 3);

  // Open a sketch panel's shot, then come back: the panel now shows the shot.
  const desk = await sb(() => window.__sb.sb.panels.findIndex((p) => p.sketch === 'sample_desk.png'));
  await page.dblclick(`.sb-panel >> nth=${desk} >> .sb-head`);
  await page.waitForFunction(() => window.__rig?.timeline, null, { timeout: 20000 });
  ok('double-click opens the panel as a shot of the same length', await page.evaluate(() => window.__rig.shot.length) === Math.round(3.2 * 24));
  await page.click('#to-storyboard');
  await page.waitForSelector('.sb-panel');
  ok('back on the storyboard, the panel keeps its shot', await sb((i) => !!window.__sb.sb.panels[i].shot, desk));
  await page.reload();
  await page.waitForSelector('.sb-panel');
  ok('reload reopens the storyboard with everything in it', (await ids()).length === count + 3 && await sb(() => window.__sb.sb.panels.some((p) => p.notes.endsWith('A grabs it.'))));
  // A scratch take on a panel sets its length (the test browser's fake microphone plays a tone).
  await page.click(`.sb-panel >> nth=${count} >> .sb-head`);
  await page.click('#sb-record');
  await page.waitForTimeout(1600);
  await page.click('#sb-record');
  await page.waitForFunction((i) => window.__sb.sb.sound?.some((c) => c.take && c.panel === window.__sb.sb.panels[i].id), count, { timeout: 10000 });
  const took = await sb((i) => ({ secs: window.__sb.sb.panels[i].duration, take: !!document.querySelector(`.sb-panel[data-id="${window.__sb.sb.panels[i].id}"] .sb-take`) }), count);
  ok('Record line keeps a take and the panel becomes as long as it', took.take && took.secs > 1 && took.secs < 2.5, JSON.stringify(took));
  await page.click('#clear-sample');
  ok('Clear sample removes only the sample panels', (await ids()).length === count + 3 - 3 && await sb(() => window.__sb.sb.panels.every((p) => !p.sample)));
  await context.close();
}

// --- import: every placeholder --------------------------------------------------
if (want('import')) {
  for (const label of ['High', 'Medium', 'Low', 'PSD (Procreate style)']) {
    const { context, page } = await open(label);
    if (await page.$('.status.error')) { ok(`import ${label}`, false, await page.textContent('.status.error')); await context.close(); continue; }
    const report = await page.$$eval('.issues li, .review .ok', (n) => n.map((e) => e.textContent));
    await page.click('#open-editor');
    await ready(page);
    const info = await ev(page, () => { const ed = window.__rig, v = ed.view(); return { level: ed.rig().level, pivots: Object.keys(v.pivots).length, pieces: Object.keys(v.pieces).length, mouths: Object.keys(v.pieces).filter((p) => p.startsWith('mouth_')).length }; });
    ok(`import ${label}: ${info.level}, ${info.pivots} pivots, ${info.pieces} pieces, ${info.mouths} mouths`, info.pivots >= 5 && info.mouths === 8 && !report.some((r) => /^(Problem|Missing)/.test(r)), report.join(' | '));
    await page.screenshot({ path: `${out}/import-${label.split(' ')[0].toLowerCase()}.png` });
    await context.close();
  }
}

const { context, page } = await open('High');
await page.click('#open-editor');
await settle(page);

// --- first look: filmstrip on top, inspector on the right, + Add on the stage ---------------
if (want('pose')) {
  const first = await ev(page, () => ({
    steps: document.querySelectorAll('.step').length, film: document.querySelectorAll('.film').length, current: !!document.querySelector('.film.current'),
    inspector: getComputedStyle(document.querySelector('.inspector')).display !== 'none', layers: [...document.querySelectorAll('.layer')].map((l) => l.dataset.layer),
    add: !!document.querySelector('#add summary'), atRest: [...document.querySelectorAll('.toolbar > button, .toolbar > select, .toolbar > details > summary, .action-bar button, .action-bar summary, .tl-bar > button, .tl-bar > label, .tl-bar > details > summary, .tl-bar > .seg button')].length,
  }));
  ok('no step wizard; a filmstrip marks the current shot', first.steps === 0 && first.film >= 1 && first.current, JSON.stringify(first));
  ok('the inspector is open, with the layer list: camera, then the character', first.inspector && first.layers[0] === 'camera' && first.layers.length === 2, JSON.stringify(first.layers));
  ok('+ Add sits on the stage', first.add);
  console.log(`    controls showing at rest outside the stage and inspector: ${first.atRest}`);
  await page.screenshot({ path: `${out}/first-look.png` });
  await page.keyboard.press('?');
  ok('? shows the keyboard shortcuts', await page.locator('.keys-help:not([hidden])').count() === 1);
  await page.screenshot({ path: `${out}/shortcuts.png` });
  await page.keyboard.press('Escape');
  ok('Esc closes them', await page.locator('.keys-help[hidden]').count() === 1);
}
await ready(page);

// --- pose: FK, IK, swaps, library, undo ---------------------------------------------
if (want('pose')) {
  // Moving the view: a plain left-drag never pans; Space+drag, two-finger scroll and pinch do.
  const origin = () => ev(page, () => window.__rig.stage.worldToScreen({ x: 0, y: 0 }));
  const box0 = await stageBox(page), empty = { x: 40, y: box0.height - 60 };
  let o0 = await origin();
  await drag(page, empty, 80, -50);
  let o1 = await origin();
  ok('a left-drag on empty stage does not move the view', near(o0.x, o1.x) && near(o0.y, o1.y), JSON.stringify([o0, o1]));
  ok('clicking empty stage shows the shot in the inspector', await ev(page, () => window.__rig.focus) === 'shot');
  await page.mouse.move(box0.x + empty.x, box0.y + empty.y);
  await page.keyboard.down('Space');
  await drag(page, empty, 80, -50);
  await page.keyboard.up('Space');
  o1 = await origin();
  ok('Space+drag moves the view', near(o1.x - o0.x, 80, 2) && near(o1.y - o0.y, -50, 2), JSON.stringify([o0, o1]));
  o0 = o1;
  await page.mouse.wheel(30, 20);
  await page.waitForTimeout(100);
  o1 = await origin();
  ok('two-finger scroll moves the view', near(o1.x - o0.x, -30, 2) && near(o1.y - o0.y, -20, 2), JSON.stringify([o0, o1]));
  const zoom0 = await ev(page, () => window.__rig.stage.worldToScreen({ x: 100, y: 0 }).x - window.__rig.stage.worldToScreen({ x: 0, y: 0 }).x);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -8);
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  const zoom1 = await ev(page, () => window.__rig.stage.worldToScreen({ x: 100, y: 0 }).x - window.__rig.stage.worldToScreen({ x: 0, y: 0 }).x);
  ok('pinch (Ctrl+wheel) zooms in', zoom1 > zoom0 * 1.03, `${zoom0} → ${zoom1}`);
  await ev(page, () => { window.__rig.fitView(); window.__rig.redraw(); });

  // A click on the character selects it, and does not store a pose.
  const keys0 = await ev(page, () => window.__rig.shot.actors[0].keys.length);
  const body = await at(page, 'chest', { x: 300, y: 330 });
  const sb0 = await stageBox(page);
  await page.mouse.click(sb0.x + body.x, sb0.y + body.y);
  ok('clicking a character selects it without keying', await ev(page, () => window.__rig.focus) === 'actor' && await ev(page, () => window.__rig.shot.actors[0].keys.length) === keys0);
  ok('the character bar shows on the selected character', await ev(page, () => !document.querySelector('.char-bar').hidden && !!document.querySelector('.char-bar [data-swap="mouth"]')));

  await drag(page, await at(page, 'forearm_L', { x: 382, y: 440 }), 60, -40);
  ok('FK drag turns the elbow', Math.abs((await angles(page)).elbow_L) > 20, JSON.stringify(await angles(page)));
  const hand = await at(page, 'hand_R', { x: 214, y: 498 });
  await drag(page, hand, 30, -120);
  const a1 = await angles(page);
  ok('IK drag bends shoulder and elbow', Math.abs(a1.shoulder_R) > 5 && Math.abs(a1.elbow_R) > 20, JSON.stringify(a1));
  const before = await ev(page, () => ({ ...window.__rig.pose().root }));
  await drag(page, await at(page, 'pelvis', { x: 300, y: 500 }), 40, 0);
  const after = await ev(page, () => ({ ...window.__rig.pose().root }));
  ok('dragging the hips moves the character', after.x - before.x > 20);
  await page.keyboard.press('Control+z');
  ok('undo puts it back', near((await ev(page, () => window.__rig.pose().root.x)), before.x));
  await page.keyboard.press('Control+Shift+z');
  ok('redo moves it again', near((await ev(page, () => window.__rig.pose().root.x)), after.x));

  // Swaps: mouth layer, and a shared hand placed on each wrist.
  await page.selectOption('[data-swap="mouth"]', 'a');
  await page.selectOption('[data-swap="hand_L"]', 'point');
  await page.selectOption('[data-swap="hand_R"]', 'fist');
  const swaps = await ev(page, () => window.__rig.pose().swaps);
  ok('swaps stored in the pose', swaps.mouth === 'a' && swaps.hand_L === 'point' && swaps.hand_R === 'fist', JSON.stringify(swaps));
  await page.click('#reset-pose');
  await page.selectOption('[data-swap="mouth"]', 'o');
  await page.selectOption('[data-swap="hand_L"]', 'point');
  await page.selectOption('[data-swap="hand_R"]', 'fist');
  await setAngles(page, { shoulder_L: -70, elbow_L: -30, shoulder_R: 40 });
  await page.screenshot({ path: `${out}/pose-swaps.png` });

  // Library.
  await page.fill('#pose-name', 'Point');
  await page.click('#save-pose');
  await page.click('#reset-pose');
  ok('reset clears angles and swaps', Object.values(await angles(page)).every((v) => !v) && !(await ev(page, () => window.__rig.pose().swaps)));
  await page.click('[data-pose="Point"] .pose-card');
  const back = await ev(page, () => ({ a: window.__rig.pose().angles.shoulder_L, s: window.__rig.pose().swaps }));
  ok('library pose restores angles and swaps', near(back.a, -70) && back.s?.hand_L === 'point', JSON.stringify(back));
  await page.click('[data-pose="Point"] >> text=Mirror');
  ok('mirror swaps sides', near((await angles(page)).shoulder_R, 70));
  await page.click('[data-pose="Point"] >> text=Delete');
  ok('deleting a library pose', await ev(page, () => window.__rig.project.poses.length) === 0);
  await ev(page, () => { window.__rig.commit(); window.__rig.undo(); });
  await page.waitForTimeout(200);
  ok('undo brings the pose back, thumbnail included', await ev(page, () => { const p = window.__rig.project.poses[0]; return p?.name === 'Point' && !!p.thumb; }));
  ok('cut from the plan: no controllers, exact angles or per-pose draw order', await page.locator('#new-joystick, [data-angle], [data-more="pose-order"]').count() === 0);
  await page.click('#reset-pose');
}

// --- animate: keys, easing, timing, onion, shortcuts -----------------------------------------
if (want('animate')) {
  await pickActor(page);
  await page.click('#reset-pose');
  // Auto-record is on by default: posing two frames makes an animation with no K at all.
  ok('auto-record is on by default', await page.locator('#auto-key').isChecked());
  await ev(page, () => { const ed = window.__rig; ed.sel().keys = []; ed.setFrame(0); ed.refresh(); });
  await setAngles(page, { shoulder_L: -90 });
  await ev(page, () => window.__rig.setFrame(47));
  await setAngles(page, { shoulder_L: 0 });
  ok('auto-record keeps a pose on each frame it was made', await ev(page, () => window.__rig.sel().keys.map((k) => k.frame).join()) === '0,47');
  ok('auto-record says where the pose went', /Pose saved · frame 48/.test(await page.textContent('.hint')), await page.textContent('.hint'));
  await ev(page, () => window.__rig.setFrame(0));
  ok('and the first pose is still there', near((await angles(page)).shoulder_L, -90));
  // Frame stepping with , and .
  await page.locator('.stage canvas').focus().catch(() => {});
  await ev(page, () => document.activeElement.blur());
  await page.keyboard.press('.');
  await page.keyboard.press('.');
  await page.keyboard.press(',');
  ok(', and . step one frame', await ev(page, () => window.__rig.frame) === 1);
  // The rest of this section checks manual keying, with auto-record turned off.
  await page.uncheck('#auto-key');
  await ev(page, () => { const ed = window.__rig; ed.sel().keys = []; ed.setFrame(0); ed.refresh(); });
  await page.click('#reset-pose');
  await ev(page, () => document.activeElement.blur());
  await page.keyboard.press('k');
  ok('K says the key is set', /Key set · frame 1/.test(await page.textContent('.hint')));
  await ev(page, () => window.__rig.setFrame(24));
  await setAngles(page, { shoulder_L: -120, elbow_L: -40 });
  ok('an edit off a key is flagged as not keyed', await page.locator('#unsaved').count() === 1);
  await ev(page, () => window.__rig.setFrame(10));
  await ev(page, () => window.__rig.setFrame(24));
  ok('leaving the frame drops an edit that was not keyed', near((await angles(page)).shoulder_L ?? 0, 0));
  await setAngles(page, { shoulder_L: -120, elbow_L: -40 });
  await page.click('#set-key');
  ok('two keys on the timeline', await ev(page, () => window.__rig.sel().keys.length) === 2);
  await ev(page, () => window.__rig.setFrame(12));
  ok('halfway between keys the pose is halfway (ease)', near((await angles(page)).shoulder_L, -60, 2), JSON.stringify(await angles(page)));
  await ev(page, () => window.__rig.setFrame(6));
  const eased = (await angles(page)).shoulder_L;
  ok('ease starts slowly', eased > -25 && eased < -5, String(eased));
  await ev(page, () => window.__rig.setFrame(0));
  await page.selectOption('#ease', 'linear');
  await ev(page, () => window.__rig.setFrame(6));
  ok('even spacing is linear', near((await angles(page)).shoulder_L, -30, 2));
  await ev(page, () => window.__rig.setFrame(0));
  await page.selectOption('#ease', 'hold');
  await ev(page, () => window.__rig.setFrame(23));
  ok('hold keeps the first pose until the next key', near((await angles(page)).shoulder_L ?? 0, 0));
  await ev(page, () => window.__rig.setFrame(0));
  await page.selectOption('#ease', 'linear');
  await page.click('[data-timing="3"]');
  const t7 = await ev(page, () => { window.__rig.setFrame(7); return window.__rig.pose().angles.shoulder_L; });
  const t8 = await ev(page, () => { window.__rig.setFrame(8); return window.__rig.pose().angles.shoulder_L; });
  ok('on threes, frames 7 and 8 show the drawing of frame 7', near(t7, -30, 0.5) && near(t8, -30, 0.5), `${t7} ${t8}`);
  await page.click('[data-timing="1"]');
  await page.check('#auto-key');
  await ev(page, () => window.__rig.setFrame(40));
  await setAngles(page, { neck: 20 });
  ok('auto-record stores the change', await ev(page, () => window.__rig.sel().keys.some((k) => k.frame === 40)));
  await page.uncheck('#auto-key');
  // Drag a key on the timeline.
  const tl = await page.locator('.tl-canvas').boundingBox();
  const keyRow = await ev(page, () => { const t = window.__rig.timeline; let y = 0; for (const r of t.rows) { if (r.kind === 'keys') return y + r.h / 2; y += r.h; } });
  await page.mouse.move(tl.x + 40 * 10 + 5, tl.y + keyRow); await page.mouse.down();
  await page.mouse.move(tl.x + 47 * 10 + 5, tl.y + keyRow, { steps: 6 }); await page.mouse.up();
  ok('dragging a key moves it', await ev(page, () => window.__rig.sel().keys.map((k) => k.frame).join()) === '0,24,47');
  await page.mouse.move(tl.x + 12 * 10 + 5, tl.y + 10); await page.mouse.down(); await page.mouse.up();
  ok('clicking the ruler moves the playhead', await ev(page, () => window.__rig.frame) === 12);
  await page.check('#onion');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/animate-onion.png` });
  await page.uncheck('#onion');
  await ev(page, () => window.__rig.setFrame(0));
  await page.click('#play');
  await page.waitForTimeout(700);
  const playing = await ev(page, () => window.__rig.frame);
  await page.click('#play');
  ok('play advances the playhead', playing > 5, String(playing));
}

// --- scene: + Add, the layer stack, hide and lock, extras, placing, framing -----------------
if (want('scene')) {
  await addMenu(page, '#add-import');
  await page.click('[data-placeholder="Medium"]');
  await page.click('#open-editor');
  await ready(page);
  ok('a character imported from + Add lands in the shot', await ev(page, () => window.__rig.shot.actors.length) === 2);
  await page.click('#add summary');
  ok('+ Add lists the characters in this scene first', await ev(page, () => [...document.querySelectorAll('[data-add-character]')].every((b) => /in this scene/.test(b.textContent))));
  await page.click('[data-add-character="placeholder_medium"]');
  ok('the same character can be added again', await ev(page, () => window.__rig.shot.actors.length) === 3);
  await page.selectOption('#actor-role', 'extra');
  ok('a character can be an extra', await ev(page, () => window.__rig.sel().role) === 'extra');
  await page.click('#extra-loop');
  await setAngles(page, { shoulder_L: -80 });
  await page.click('#loop-add');
  await page.fill('#loop-hold', '6'); await page.keyboard.press('Tab');
  const loop = await ev(page, async () => {
    const ed = window.__rig, a = ed.sel(), m = await import('/src/model/shot.ts');
    return { n: a.loop.poses.length, f0: Math.round(m.evaluate(ed.shot, a, 0).angles.shoulder_L ?? 0), f6: Math.round(m.evaluate(ed.shot, a, 6).angles.shoulder_L ?? 0), keys: a.keys.length };
  });
  ok('an extra loops between poses with no keys', loop.n === 2 && loop.f0 !== loop.f6 && loop.keys === 0, JSON.stringify(loop));
  // Background: a generated PNG, locked and at the back.
  const png = await ev(page, () => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = 960; c.height = 640; const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 640); grad.addColorStop(0, '#bfe3ff'); grad.addColorStop(0.7, '#e8f6ff'); grad.addColorStop(0.7, '#9bcf8a'); grad.addColorStop(1, '#6faa62');
    g.fillStyle = grad; g.fillRect(0, 0, 960, 640); g.fillStyle = '#fff'; g.beginPath(); g.arc(760, 120, 60, 0, 7); g.fill();
    c.toBlob(async (b) => res([...new Uint8Array(await b.arrayBuffer())]));
  }));
  writeFileSync(`${out}/park.png`, Buffer.from(png));
  await page.click('#add summary');
  await choose(page, '#add-background', `${out}/park.png`);
  await page.waitForFunction(() => window.__rig.shot.backgrounds.length === 1);
  const bg = await ev(page, async () => { const ed = window.__rig, b = ed.shot.backgrounds[0], m = await import('/src/model/shot.ts'); return { scale: b.scale, locked: b.locked, first: m.stackOrder(ed.shot)[0] === b.id }; });
  ok('a background covers the stage, starts locked and sits at the back', bg.scale >= 3 && bg.locked && bg.first, JSON.stringify(bg));
  // Clicking where only the locked background is selects nothing.
  const corner = await ev(page, () => { const ed = window.__rig, c = ed.camera(); return ed.stage.worldToScreen({ x: c.x - c.width * 0.45, y: c.y - c.width * 0.2 }); });
  const sbox = await stageBox(page);
  await page.mouse.click(sbox.x + corner.x, sbox.y + corner.y);
  ok('a locked background is never picked on the stage', await ev(page, () => window.__rig.focus) === 'shot');
  // Restack by dragging rows in the layer list: put the first character behind the background.
  await pickActor(page, 0);
  const first = await ev(page, () => window.__rig.shot.actors[0].id);
  const rowA = await page.locator(`.layer[data-id="${first}"]`).boundingBox(), rowBg = await page.locator(`.layer[data-id="${await ev(page, () => window.__rig.shot.backgrounds[0].id)}"]`).boundingBox();
  await page.mouse.move(rowA.x + 60, rowA.y + rowA.height / 2); await page.mouse.down();
  await page.mouse.move(rowA.x + 60, rowA.y + rowA.height / 2 + 10, { steps: 3 });
  await page.mouse.move(rowA.x + 60, rowBg.y + rowBg.height - 2, { steps: 8 }); await page.mouse.up();
  const stack = await ev(page, async () => { const ed = window.__rig, m = await import('/src/model/shot.ts'); return m.stackOrder(ed.shot); });
  ok('dragging a row in the layer list restacks', stack[0] === first, JSON.stringify(stack));
  await page.keyboard.press('Control+z');
  ok('undo restacks it back', (await ev(page, async () => (await import('/src/model/shot.ts')).stackOrder(window.__rig.shot)))[0] !== first);
  // Hide and lock with one click.
  await page.click(`.layer[data-id="${first}"] [data-toggle="hidden"]`);
  ok('Hide takes a character off the stage', await ev(page, (id) => window.__rig.shot.actors.find((a) => a.id === id).hidden === true && !window.__rig.stage.actor({ id, rig: window.__rig.rig(window.__rig.shot.actors[0]) })?.container.parent, first));
  await page.click(`.layer[data-id="${first}"] [data-toggle="hidden"]`);
  await page.click(`.layer[data-id="${first}"] [data-toggle="locked"]`);
  const lockedAt = await ev(page, () => { const ed = window.__rig, a = ed.shot.actors[0], b = ed.stage.actor({ id: a.id, rig: ed.rig(a) }).bounds(); return ed.stage.worldToScreen({ x: b.x + b.w / 2, y: b.y + b.h * 0.3 }); });
  await page.mouse.click(sbox.x + lockedAt.x, sbox.y + lockedAt.y);
  ok('a locked character is not picked', await ev(page, (id) => !(window.__rig.focus === 'actor' && window.__rig.selId === id), first));
  await page.click(`.layer[data-id="${first}"] [data-toggle="locked"]`);
  // Move in every frame.
  await pickActor(page, 0);
  await page.click('#place-mode');
  const x0 = await ev(page, () => window.__rig.pose().root.x);
  const sel = await ev(page, () => { const ed = window.__rig, b = ed.stage.actor({ id: ed.sel().id, rig: ed.rig() }).bounds(); return ed.stage.worldToScreen({ x: b.x + b.w / 2, y: b.y + b.h * 0.45 }); });
  await drag(page, sel, 90, 10);
  ok('Move in every frame places the character', (await ev(page, () => window.__rig.pose().root.x)) - x0 > 40);
  await page.click('#mode-done');
  // Framing: pick Camera in the layer list.
  await page.click('.layer[data-layer="camera"]');
  ok('the camera is in the inspector', await page.locator('#format').count() === 1);
  ok('cut from the plan: no 4:3 or 3:4 shapes offered', await ev(page, () => [...document.querySelectorAll('#format option')].every((o) => !['yt43', 'post34'].includes(o.value))));
  await page.fill('#cam-x', '1300'); await page.keyboard.press('Tab');
  const follow = await ev(page, () => { const c = window.__rig.shot.cameras; return { yt: c.yt.x, shorts: c.shorts.x, post: c.post45.x, tall: c.shorts.width * 1920 / 1080, ytTall: c.yt.width * 1080 / 1920 }; });
  ok('other shapes follow the 16:9 frame until framed themselves', follow.shorts === 1300 && follow.post === 1300 && near(follow.tall, follow.ytTall), JSON.stringify(follow));
  await page.fill('#cam-x', '1440'); await page.keyboard.press('Tab');
  await page.selectOption('#format', 'shorts');
  await page.fill('#cam-x', '1500'); await page.keyboard.press('Tab');
  await page.selectOption('#format', 'yt');
  await page.fill('#cam-x', '1400'); await page.keyboard.press('Tab');
  const cams = await ev(page, () => ({ yt: window.__rig.shot.cameras.yt.x, shorts: window.__rig.shot.cameras.shorts.x, post: window.__rig.shot.cameras.post45.x }));
  ok('a shape framed by hand keeps its own framing', cams.yt === 1400 && cams.shorts === 1500 && cams.post === 1400, JSON.stringify(cams));
  await page.fill('#cam-x', '1440'); await page.keyboard.press('Tab');
  for (const f of ['yt', 'shorts', 'post45']) {
    await page.selectOption('#format', f);
    const size = await ev(page, () => { const c = window.__rig.outputFrame(window.__rig.frame, true); window.__rig.redraw(); return [c.width, c.height]; });
    const wantSize = { yt: [1920, 1080], shorts: [1080, 1920], post45: [1080, 1350] }[f];
    ok(`a frame renders at ${wantSize.join('×')} for ${f}`, size[0] === wantSize[0] && size[1] === wantSize[1], size.join('x'));
  }
  await page.selectOption('#format', 'yt');
  await page.keyboard.press('Escape');
  ok('Esc clears the selection to the shot', await ev(page, () => window.__rig.focus) === 'shot');
  await page.fill('#template-name', 'Park');
  await page.click('#save-template');
  ok('the setup saves for reuse', await ev(page, () => window.__rig.project.scenes[0]?.name) === 'Park');
  await page.screenshot({ path: `${out}/scene.png` });
  // A second shot from the storyboard: empty, with + Add pointed out. [ and ] move between shots.
  await ev(page, async () => { const ed = window.__rig, m = await import('/src/model/storyboard.ts'); const p = m.newPanel('second', { duration: 2 }); ed.project.storyboard.panels.push(p); ed.ctx.openPanel(p); });
  await ready(page);
  ok('the filmstrip shows both shots', await page.locator('.film').count() === 2);
  ok('an empty shot says what to do next', await ev(page, () => !document.querySelector('.empty-note').hidden && /empty/.test(document.querySelector('.empty-note').textContent)));
  await page.click('[data-template="Park"]');
  ok('a saved setup can be used in another shot', await ev(page, () => window.__rig.shot.actors.length) === 3);
  await page.screenshot({ path: `${out}/empty.png` });
  await ev(page, () => document.activeElement.blur());
  await page.keyboard.press('[');
  await settle(page);
  ok('[ goes to the previous shot', await ev(page, () => window.__rig.shot === window.__rig.project.shots[0]));
  await page.keyboard.press(']');
  await settle(page);
  ok('] goes to the next one', await ev(page, () => window.__rig.shot === window.__rig.project.shots[1]));
  await page.click('.film >> nth=0');
  await ready(page);
}

// --- sound: scene lanes, mouths, effects, text ---------------------------------------------
if (want('sound')) {
  await ev(page, () => { const ed = window.__rig; ed.select('actor', ed.shot.actors[0].id); ed.setFrame(0); ed.refresh(); });
  writeFileSync(`${out}/line.wav`, wav(2, [[0.2, 0.6, 0.9], [0.8, 1.1, 0.4], [1.3, 1.8, 1]]));
  writeFileSync(`${out}/music.wav`, wav(6, [[0, 6, 0.3]]));
  await choose(page, '#add-voice', `${out}/line.wav`);
  await page.waitForFunction(() => window.__rig.project.storyboard.sound?.length === 1);
  await ev(page, () => { window.__rig.select('actor', window.__rig.shot.actors[0].id); window.__rig.refresh(); });
  await choose(page, '#add-music', `${out}/music.wav`);
  await page.waitForFunction(() => window.__rig.project.storyboard.sound?.length === 2);
  const lanes = await ev(page, () => window.__rig.project.storyboard.sound.map((c) => [c.lane, c.panel === window.__rig.panel_().id, c.speaker ?? '']));
  ok('voice and music go on the scene, pinned to this shot', lanes.map((l) => l.join(':')).join() === 'voice:true:placeholder_high,music:true:', JSON.stringify(lanes));
  ok('the speaker\'s mouth row sits under Voice', await ev(page, () => { const k = window.__rig.timeline.rows.map((r) => r.kind === 'lane' ? r.lane : r.kind); return k.indexOf('mouth') === k.indexOf('voice') + 1; }));
  ok('adding a voice line does not move the mouth by itself (mouths are manual)', await ev(page, () => window.__rig.shot.actors[0].mouth.length) === 0);
  // Pick the voice clip and use the quick flaps.
  await ev(page, () => { const ed = window.__rig; ed.select('clip', ed.project.storyboard.sound[0].id); ed.refresh(); });
  await page.click('[data-flaps="line.wav"]');
  const mouth = await ev(page, () => window.__rig.shot.actors[0].mouth);
  const shapeAt = (f) => [...mouth].reverse().find((m) => m.frame <= f)?.shape;
  ok('quick flaps follow the loudness', mouth.length >= 4 && shapeAt(2) === 'rest' && shapeAt(9) !== 'rest' && shapeAt(16) === 'rest' && shapeAt(38) !== 'rest', JSON.stringify(mouth));
  await pickActor(page, 0);
  await ev(page, () => window.__rig.setFrame(9));
  await page.click('[data-mouth="mbp"]');
  ok('a mouth shape can be keyed by hand', await ev(page, () => window.__rig.shot.actors[0].mouth.find((m) => m.frame === 9)?.shape) === 'mbp');
  // A starter effect.
  await ev(page, () => window.__rig.setFrame(30));
  await page.click('#add-sfx summary');
  await page.click('[data-effect="phone_buzz"]');
  await page.waitForFunction(() => window.__rig.project.storyboard.sound?.length === 3);
  ok('a starter sound effect goes on the Sound effect lane at the playhead', await ev(page, () => { const c = window.__rig.project.storyboard.sound[2]; return c.lane === 'sfx' && c.offset === 30 && window.__rig.audio.frames(c.file) > 24; }));
  // Music longer than this shot carries on into the next one.
  const across = await ev(page, async () => {
    const ed = window.__rig, m = await import('/src/model/storyboard.ts'), sb = ed.project.storyboard, next = sb.panels[1];
    return m.shotClips(sb, ed.project.shots, next.id).find((c) => c.kind === 'music')?.start;
  });
  ok('music longer than the shot plays on in the next shot', across === -(await ev(page, () => window.__rig.shot.length)), String(across));
  // The whole-scene timeline, and playing the scene.
  await ev(page, () => document.activeElement.blur());
  await page.keyboard.press('\\');
  ok('\\ shows the whole scene on the timeline', await ev(page, () => window.__rig.timeline.zoom) === 'scene' && await page.locator('[data-row="shots"]').count() === 1);
  await page.screenshot({ path: `${out}/timeline-scene.png` });
  await ev(page, () => { window.__rig.setFrame(window.__rig.shot.length - 12); });
  await page.click('#play');
  await page.waitForSelector('.player');
  await page.waitForFunction(() => document.querySelector('#player-time')?.dataset.panel === window.__rig.project.storyboard.panels[1].id, null, { timeout: 15000 });
  ok('Play the scene runs on past the cut into the next shot', true);
  await page.screenshot({ path: `${out}/player.png` });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.player', { state: 'detached' });
  await settle(page);
  await ev(page, () => { if (window.__rig.timeline.zoom === 'scene') window.__rig.timeline.toggleZoom(); });
  if (await ev(page, () => window.__rig.shot !== window.__rig.project.shots[0])) { await page.click('.film >> nth=0'); await ready(page); }
  // Subtitles and on-screen text.
  await ev(page, () => { window.__rig.select('shot'); window.__rig.setFrame(4); window.__rig.refresh(); });
  await page.click('#add-subtitle');
  await page.fill('#text-body', 'こんにちは、元気？');
  await page.keyboard.press('Tab');
  await addMenu(page, '#add-text');
  await page.fill('#text-body', 'POW!');
  await page.keyboard.press('Tab');
  ok('subtitle and on-screen text added', await ev(page, () => window.__rig.shot.texts.map((t) => t.kind).sort().join()) === 'subtitle,text');
  await ev(page, () => window.__rig.setFrame(20));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/sound.png` });
}

// --- layers: images and text on the timeline ----------------------------------------------
if (want('layers')) {
  await ev(page, () => { window.__rig.select('shot'); window.__rig.refresh(); });
  const star = await ev(page, () => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 300; const g = c.getContext('2d');
    g.fillStyle = '#ffcc33'; g.strokeStyle = '#2a2238'; g.lineWidth = 10; g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 60 : 140, a = (i * Math.PI) / 5 - Math.PI / 2; g.lineTo(150 + r * Math.cos(a), 150 + r * Math.sin(a)); }
    g.closePath(); g.fill(); g.stroke();
    c.toBlob(async (b) => res([...new Uint8Array(await b.arrayBuffer())]));
  }));
  writeFileSync(`${out}/star.png`, Buffer.from(star));
  const before = await ev(page, () => window.__rig.shot.backgrounds.length);
  await page.click('#add summary');
  await choose(page, '#add-foreground', `${out}/star.png`);
  await page.waitForFunction((n) => window.__rig.shot.backgrounds.length === n + 1, before);
  const layer = await ev(page, async () => { const ed = window.__rig, l = ed.shot.backgrounds.at(-1), m = await import('/src/model/shot.ts'); return { front: m.stackOrder(ed.shot).at(-1) === l.id, sel: ed.selBg === l.id, scale: l.scale, rows: ed.timeline.rows.map((r) => r.kind) }; });
  ok('a foreground image goes in front of everything and is selected', layer.front && layer.sel && layer.scale <= 1, JSON.stringify(layer));
  ok('the layer has its own timeline row, above the characters', layer.rows.indexOf('layer') > 0 && layer.rows.indexOf('layer') < layer.rows.indexOf('keys'), layer.rows.join());
  await ev(page, () => { const t = window.__rig.timeline; t.ppf = 5; t.render(); document.querySelector('.tl-scroll').scrollLeft = 0; });
  const tl = await page.locator('.tl-canvas').boundingBox();
  const rowY = await ev(page, () => { const t = window.__rig.timeline; let y = 0; for (const r of t.rows) { if (r.kind === 'layer' && r.layer.id === window.__rig.shot.backgrounds.at(-1).id) return y + r.h / 2; y += r.h; } });
  const len = await ev(page, () => window.__rig.shot.length);
  await page.mouse.move(tl.x + len * 5 - 2, tl.y + rowY); await page.mouse.down();
  await page.mouse.move(tl.x + 30 * 5 + 2, tl.y + rowY, { steps: 6 }); await page.mouse.up();
  await ev(page, () => { const t = window.__rig.timeline; t.ppf = 10; t.render(); });
  const span = await ev(page, () => { const l = window.__rig.shot.backgrounds.at(-1); return [l.start ?? 0, l.end]; });
  ok('dragging the end of its bar trims the layer', span[0] === 0 && span[1] > 20 && span[1] < len, JSON.stringify(span));
  const shows = await ev(page, async () => {
    const ed = window.__rig, m = await import('/src/model/shot.ts'), id = ed.shot.backgrounds.at(-1).id, end = ed.shot.backgrounds.at(-1).end;
    return [m.visibleLayers(ed.shot, end - 1).some((l) => l.id === id), m.visibleLayers(ed.shot, end).some((l) => l.id === id)];
  });
  ok('it shows only inside its bar', shows[0] === true && shows[1] === false, JSON.stringify(shows));
  await ev(page, () => window.__rig.setFrame(5));
  const lp = await ev(page, () => { const ed = window.__rig, l = ed.shot.backgrounds.at(-1), s = ed.stage.backgroundSize(l.file); return { at: ed.stage.worldToScreen({ x: l.x + s.w * l.scale / 2, y: l.y + s.h * l.scale / 2 }), x: l.x }; });
  await drag(page, lp.at, 120, -60);
  ok('an unlocked image drags on the stage', (await ev(page, () => window.__rig.shot.backgrounds.at(-1).x)) - lp.x > 60);
  await addMenu(page, '#add-text');
  ok('a text layer is added at the playhead with its own row', await ev(page, () => { const ed = window.__rig, t = ed.shot.texts.at(-1); return t.kind === 'text' && t.start === 5 && ed.timeline.rows.filter((r) => r.kind === 'text').length >= 1; }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/layers.png` });
  await ev(page, () => document.activeElement.blur());
  await page.keyboard.press('Delete');
  ok('Delete removes the selected text', await ev(page, () => window.__rig.shot.texts.filter((t) => t.text === 'Text').length) === 0);
  await page.keyboard.press('Control+z');
  ok('undo brings it back', await ev(page, () => window.__rig.shot.texts.filter((t) => t.text === 'Text').length) === 1);
  await page.keyboard.press('Control+z');
}

// --- capture: pose from a photo, and Edit rig -------------------------------------------------
if (want('capture')) {
  // The "photo" is a render of the character in a known pose, on a grey wall.
  const made = await ev(page, () => {
    const ed = window.__rig;
    ed.select('actor', ed.shot.actors[0].id); ed.setFrame(60); ed.refresh();
    const p = ed.pose(), keep = { color: ed.shot.stage.color, others: ed.shot.actors.splice(1), bg: ed.shot.backgrounds.splice(0), texts: ed.shot.texts.splice(0) };
    Object.assign(p, { angles: { shoulder_L: -100, elbow_L: -30, shoulder_R: 35, hip_R: 25, knee_R: -40 }, swaps: undefined, rootAngle: 0 });
    ed.shot.stage.color = '#8a8f98';
    const url = ed.outputFrame(60, false, 0.6).toDataURL('image/png');
    ed.shot.stage.color = keep.color; ed.shot.actors.push(...keep.others); ed.shot.backgrounds.push(...keep.bg); ed.shot.texts.push(...keep.texts);
    p.angles = {};
    ed.edited(); ed.refresh();
    return url;
  });
  writeFileSync(`${out}/pose-photo.png`, Buffer.from(made.split(',')[1], 'base64'));
  await page.click('#bar-capture');
  await page.waitForTimeout(150);
  await choose(page, '#load-photo', `${out}/pose-photo.png`);
  await page.waitForFunction(() => !/Looking/.test(document.querySelector('#capture-status')?.textContent ?? 'Looking'), null, { timeout: 60000 });
  const got = await angles(page);
  console.log('    capture:', await page.textContent('#capture-status'), JSON.stringify(got));
  ok('a photo poses the character (raised arm within 25° of the photo)', near(got.shoulder_L ?? 0, -100, 25) && near(got.shoulder_R ?? 0, 35, 25), JSON.stringify(got));
  await page.check('#capture-mirror');
  const mir = await angles(page);
  ok('mirror copies the pose to the other side', near(mir.shoulder_R ?? 0, 100, 25), JSON.stringify(mir));
  await page.screenshot({ path: `${out}/capture.png` });
  await page.uncheck('#capture-mirror');
  await page.click('#webcam-start');
  await page.waitForSelector('#webcam-capture', { timeout: 15000 });
  await page.click('#webcam-capture');
  await page.waitForFunction(() => /No person|applied|captured/.test(document.querySelector('#capture-status')?.textContent ?? ''), null, { timeout: 30000 });
  ok('webcam countdown runs and reports what it found', true);
  console.log('    webcam:', await page.textContent('#capture-status'));
  await page.click('#mode-done');
  ok('Done turns the camera off', await ev(page, () => !document.querySelector('video')));
  // Edit rig is a mode of the selected character.
  await page.click('#edit-rig');
  ok('Edit rig shows the pivots and the check report', await ev(page, () => window.__rig.mode === 'rig') && await page.locator('text=Check report').count() === 1);
  await page.screenshot({ path: `${out}/rig.png` });
  await page.keyboard.press('Escape');
  ok('Esc leaves Edit rig', await ev(page, () => window.__rig.mode) === 'pose');
}

// --- export ------------------------------------------------------------------------
if (want('export')) {
  await page.click('#open-export');
  await ev(page, () => { window.__rig.shot.length = 48; window.__rig.refresh(); });
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#export-mp4')]);
  await dl.saveAs(`${out}/shot.mp4`);
  const status = await page.textContent('#export-status');
  console.log('   ', status);
  const info = await ev(page, async () => {
    const r = window.__rig.lastExport;
    const v = document.createElement('video');
    v.muted = true; v.src = URL.createObjectURL(new Blob([r.bytes], { type: 'video/mp4' }));
    const meta = await new Promise((res) => { v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, d: v.duration }); v.onerror = () => res({ error: v.error?.message || 'cannot play' }); });
    if (meta.error) return { ...meta, size: r.bytes.length, video: r.video, audio: r.audio };
    v.currentTime = 0.8;
    await new Promise((res) => { v.onseeked = res; });
    const c = document.createElement('canvas'); c.width = 480; c.height = 270; c.getContext('2d').drawImage(v, 0, 0, 480, 270);
    const px = c.getContext('2d').getImageData(0, 0, 480, 270).data;
    let colours = new Set(); for (let i = 0; i < px.length; i += 4 * 97) colours.add(`${px[i] >> 4},${px[i + 1] >> 4},${px[i + 2] >> 4}`);
    return { ...meta, size: r.bytes.length, video: r.video, audio: r.audio, colours: colours.size, frame: c.toDataURL('image/png') };
  });
  ok(`video plays back: ${info.w}×${info.h}, ${info.d?.toFixed(2)} s, ${info.video}${info.audio ? ' + ' + info.audio : ''}, ${(info.size / 1024).toFixed(0)} KB`, info.w === 1920 && info.h === 1080 && near(info.d, 2, 0.15) && info.colours > 5, JSON.stringify({ ...info, frame: undefined }));
  ok('video has the scene\'s sound for this shot', !!info.audio);
  if (info.frame) writeFileSync(`${out}/video-frame.png`, Buffer.from(info.frame.split(',')[1], 'base64'));
  const [png] = await Promise.all([page.waitForEvent('download'), page.click('#export-frame')]);
  await png.saveAs(`${out}/frame.png`);
  const [srt] = await Promise.all([page.waitForEvent('download'), page.click('#export-srt')]);
  const srtText = (await (await srt.createReadStream()).toArray()).join('');
  ok('subtitles export as .srt', /1\n00:00:00,167 --> 00:00:02,167\nこんにちは、元気？/.test(srtText), JSON.stringify(srtText));
  await ev(page, () => { window.__rig.shot.length = 6; window.__rig.refresh(); });
  const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#export-png-seq')]);
  ok('PNG sequence exports', (await zip.suggestedFilename()).endsWith('_frames.zip'));
  await ev(page, () => { window.__rig.shot.length = 96; window.__rig.refresh(); });
}

// --- save: reload keeps the whole project ------------------------------------------
if (want('save')) {
  await page.waitForTimeout(900);
  const snap = () => ev(page, () => { const p = window.__rig.project, s = window.__rig.shot; return JSON.stringify({ chars: p.characters.map((c) => c.name), poses: p.poses.length, scenes: p.scenes.length, assets: [...p.assets.keys()].sort(), actors: s.actors.map((a) => [a.character, a.role, a.keys.length, a.mouth.length, !!a.loop]), bg: s.backgrounds.length, sound: p.storyboard.sound?.length ?? 0, texts: s.texts.length, cams: s.cameras.shorts, order: s.order ?? null }); });
  const a = await snap();
  await page.reload();
  await ready(page);
  const b = await snap();
  ok('reload keeps characters, shot, keys, stack, sound, text and images', a === b, `\n   before ${a}\n   after  ${b}`);
  const zip = await ev(page, async () => {
    const p = await import('/src/project/project.ts'), s = await import('/src/project/store.ts');
    const files = s.fromZip(s.toZip(p.projectToFiles(window.__rig.project)));
    const back = await p.filesToProject(files);
    return { paths: [...files.keys()].sort(), shots: back.shots.length, chars: back.characters.length, sound: back.storyboard?.sound?.length ?? 0 };
  });
  ok('project zip round trip', zip.shots >= 1 && zip.chars === (JSON.parse(a).chars.length) && zip.sound === JSON.parse(a).sound);
  console.log('    project files:\n      ' + zip.paths.join('\n      '));
  await ev(page, () => document.activeElement.blur());
  await page.keyboard.press('Control+ArrowUp');
  await page.waitForSelector('.sb-panel');
  ok('Ctrl+↑ goes back to the storyboard', true);
}

console.log(errors.length ? `\nPAGE ERRORS:\n${[...new Set(errors)].slice(0, 10).join('\n')}` : '\nNo page errors.', fail ? `${fail} FAILED` : 'All passed.');
await context.close();
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
