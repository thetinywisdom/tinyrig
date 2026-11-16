// End-to-end check in a real browser. Needs `npm run dev` running.
//   node scripts/check.mjs [outDir] [section...]     sections: storyboard import act characters save
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

/** A file chooser opened by a button, answered with a file. */
async function choose(page, selector, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(selector)]);
  await chooser.setFiles(file);
}

const fresh = async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e.stack || e)));
  page.on('console', (m) => m.type() === 'error' && !/^INFO:/.test(m.text()) && errors.push(m.text()));
  await page.goto(APP);
  return { context, page };
};

// --- storyboard: start screen, sample, panels, undo, reorder, sketches ---------------------
if (want('storyboard')) {
  const { context, page } = await fresh();
  ok('a first visit shows New scene and Open scene', await page.locator('#new-scene').isVisible() && await page.locator('#open-scene').isVisible());
  await page.click('#new-scene');
  await page.waitForSelector('.sb-panel');
  const ids = () => page.$$eval('.sb-panel', (n) => n.map((e) => e.dataset.id));
  const sb = (fn, arg) => page.evaluate(fn, arg);
  ok('a new scene has 3 sample panels', (await ids()).length === 3);
  await page.waitForFunction(() => document.querySelector('.sb-panel img')?.src.startsWith('data:image/jpeg'), null, { timeout: 15000 });
  ok('the acted sample panel shows its character and how many poses', /poses/.test(await page.textContent('.sb-panel >> nth=0 >> .sb-head')));
  ok('the header counts panels', /· 3 panels$/.test(await page.textContent('#sb-summary')), await page.textContent('#sb-summary'));
  await page.screenshot({ path: `${out}/storyboard.png` });
  await page.click('.sb-panel >> nth=1 >> .sb-dur');
  await page.fill('.sb-dur-input', '3.2');
  await page.keyboard.press('Enter');
  ok('a sketch panel takes a typed length', (await page.textContent('.sb-panel >> nth=1 >> .sb-head')).includes('3.2s'));
  ok('an acted panel takes its length from its poses (no box to type in)', await page.locator('.sb-panel >> nth=0 >> .sb-dur-input').count() === 0 && await page.locator('.sb-panel >> nth=0 >> .sb-dur.fixed').count() === 1);
  await page.click('#sb-add');
  ok('Add panel adds one at the end', (await ids()).length === 4);
  await page.click('.sb-panel >> nth=0 >> .sb-head');
  await page.keyboard.press('Control+d');
  ok('Ctrl+D duplicates a panel, poses and all', (await ids()).length === 5 && await sb(() => window.__sb.sb.panels[1].moments?.length === window.__sb.sb.panels[0].moments?.length));
  const before = await ids();
  await page.keyboard.press('Delete');
  ok('Delete removes a panel with an Undo message', (await ids()).length === 4 && /deleted/.test(await page.textContent('.toast')));
  await page.click('#toast-undo');
  ok('Undo brings it back', (await ids()).join() === before.join());
  ok('the selected panel offers Act it out', await page.locator('#sb-open').count() === 1);
  await page.dblclick('.sb-panel >> nth=2 >> .sb-head');
  await page.waitForSelector('.act-card');
  ok('double-click opens Act it out', await page.locator('#act-photos').count() === 1);
  await page.click('#act-back');
  await page.waitForSelector('.sb-panel');
  await page.click('#clear-sample');
  ok('Clear sample removes only the sample panels', await sb(() => window.__sb.sb.panels.every((p) => !p.sample)));
  await context.close();
}

// --- import: every placeholder, three angles --------------------------------------------
if (want('import')) {
  for (const label of ['High', 'Medium', 'Low', 'PSD (Procreate style)']) {
    const { context, page } = await fresh();
    await page.click('#new-scene'); await page.waitForSelector('.sb-panel');
    await page.click('#clear-sample');
    await page.click('#sb-characters');
    await page.click('#chars-import');
    await page.click(`[data-placeholder="${label}"]`);
    await page.waitForSelector('#open-editor, .status.error', { timeout: 90000 });
    if (await page.$('.status.error')) { ok(`import ${label}`, false, await page.textContent('.status.error')); await context.close(); continue; }
    const report = await page.$$eval('.issues li, .review .ok', (n) => n.map((e) => e.textContent));
    await page.click('#open-editor');
    await page.waitForSelector('.chars-tabs');
    const views = await page.$$eval('.chars-tabs button:not([disabled])', (b) => b.map((x) => x.dataset.view));
    const svg = !label.startsWith('PSD');
    ok(`import ${label}: angles ${views.join(', ')}`, (svg ? views.join() === 'front,quarter,side' : views.length >= 2) && !report.some((r) => /^(Problem|Missing)/.test(r)), report.join(' | '));
    await page.screenshot({ path: `${out}/import-${label.split(' ')[0].toLowerCase()}.png` });
    await context.close();
  }
}

// --- a creature with layer names of its own: the 4-legged rig, attached by name -------------
if (want('characters')) {
  const { context, page } = await fresh();
  await page.click('#new-scene'); await page.waitForSelector('.sb-panel');
  await page.click('#sb-characters');
  const box = { x: 0, y: 0 };
  // A creature drawn with names of your own: it gets the 4-legged rig, layers attached by name.
  await page.click('#chars-import');
  await page.setInputFiles('.importer input[type=file]', 'scripts/fixtures/char_cat.svg');
  await page.waitForSelector('#open-editor', { timeout: 60000 });
  ok('a cat imports as a 4-legged rig', /4 legs rig/.test(await page.textContent('.review')), await page.textContent('.review'));
  await page.click('#open-editor');
  await page.waitForSelector('[data-layer="tail"]');
  ok('the tail layer moves with the Tail node', /Tail\s*→ Tail/.test(await page.textContent('[data-layer="tail"]')));
  ok('the front paw layer moves with L front paw', /→ L front paw/.test(await page.textContent('[data-layer="front_paw_L"]')));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/characters-cat.png` });
  // Bend the tail.
  const tail = await page.evaluate(() => { const c = window.__chars, v = c.rigView(); const b = v.pieces.tail.bbox; return c.stage.worldToScreen({ x: b.x + b.w * 0.8, y: b.y + b.h / 2 }); });
  Object.assign(box, await page.locator('.chars-stage canvas').boundingBox());
  await page.mouse.move(box.x + tail.x, box.y + tail.y); await page.mouse.down();
  await page.mouse.move(box.x + tail.x, box.y + tail.y - 60, { steps: 6 }); await page.mouse.up();
  ok('the tail bends around its node', await page.evaluate(() => Math.abs(window.__chars.trial?.angles.tail ?? 0) > 5));
  await context.close();
}

// From here on, one browser: a new scene, the sample cleared, the High placeholder imported.
const { context, page } = await fresh();
await page.click('#new-scene'); await page.waitForSelector('.sb-panel');
await page.click('#clear-sample');
await page.click('#sb-characters');
await page.click('#chars-import');
await page.click('[data-placeholder="High"]');
await page.click('#open-editor', { timeout: 90000 });
await page.waitForSelector('.chars-tabs');
const ev = (fn, arg) => page.evaluate(fn, arg);

// --- characters: angles, joints, looks, trying a bend -------------------------------------
if (want('characters')) {
  ok('the imported character is listed with its angles', /Front · 3\/4 · Side/.test(await page.textContent('.chars-who.sel')));
  ok('Back is offered but greyed out: no back drawing', await page.locator('.chars-tabs [data-view="back"][disabled]').count() === 1);
  await page.click('.chars-tabs [data-view="quarter"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/characters-quarter.png` });
  ok('a 3/4 drawing says which way it looks', await page.locator('[data-faces="left"].selected').count() === 1);
  await page.click('[data-faces="right"]');
  ok('Looks: Right is kept on the drawing', await ev(() => window.__project().characters[0].data.rig.views.quarter.faces) === 'right');
  await page.click('[data-faces="left"]');
  // Drag the left elbow dot.
  const box = await page.locator('.chars-stage canvas').boundingBox();
  const elbow = await ev(() => { const c = window.__chars, v = c.rigView(); return c.stage.worldToScreen(v.pivots.elbow_L); });
  const was = await ev(() => ({ ...window.__chars.rigView().pivots.elbow_L }));
  await page.mouse.move(box.x + elbow.x, box.y + elbow.y); await page.mouse.down();
  await page.mouse.move(box.x + elbow.x + 20, box.y + elbow.y + 10, { steps: 5 }); await page.mouse.up();
  const now = await ev(() => ({ ...window.__chars.rigView().pivots.elbow_L }));
  ok('dragging a dot moves that joint', Math.hypot(now.x - was.x, now.y - was.y) > 10, JSON.stringify([was, now]));
  // Try a bend by dragging the forearm: not kept.
  const fore = await ev(() => { const c = window.__chars, rig = c.rig(), v = c.rigView(); const p = v.pivots.wrist_L ?? v.tips.arm_L; return c.stage.worldToScreen({ x: (v.pivots.elbow_L.x + p.x) / 2, y: (v.pivots.elbow_L.y + p.y) / 2 }); });
  await page.mouse.move(box.x + fore.x, box.y + fore.y); await page.mouse.down();
  await page.mouse.move(box.x + fore.x + 60, box.y + fore.y - 30, { steps: 6 }); await page.mouse.up();
  ok('dragging a part tries a bend', await ev(() => Math.abs(window.__chars.trial?.angles.elbow_L ?? 0) > 5));
  ok('nothing tried is kept on the rig', await ev(() => !window.__project().poses.length));
  await page.click('#chars-reset');
  await page.click('.chars-tabs [data-view="front"]');

  // Named nodes and layers.
  ok('nodes have names: the left wrist node is "L hand"', await page.inputValue('[data-node="wrist_L"] input') === 'L hand');
  ok('names show on the drawing', (await page.textContent('.chars-marks')).includes('L hand'));
  ok('layers show by name with the node that moves them', /L hand\s*→ L hand/.test(await page.textContent('[data-layer="hand_L"]')));
  // Click a layer, then a node: that node moves it.
  await page.click('[data-layer="hand_L"]');
  ok('picking a layer asks for its node', /click the node that moves L hand/.test(await page.textContent('#chars-hint')));
  await page.click('[data-node="elbow_L"] .muted');
  ok('a layer then a node attaches it', await ev(() => window.__chars.rigView().pieces.hand_L.bone) === 'forearm_L');
  await page.keyboard.press('Control+z');
  ok('undo puts it back', await ev(() => window.__chars.rigView().pieces.hand_L.bone) === 'hand_L');
  // Add a node on the left forearm and name it like a layer: the layer attaches by itself.
  await page.click('#chars-add');
  const mid = await ev(() => { const c = window.__chars, v = c.rigView(); return c.stage.worldToScreen({ x: (v.pivots.elbow_L.x + v.pivots.wrist_L.x) / 2, y: (v.pivots.elbow_L.y + v.pivots.wrist_L.y) / 2 }); });
  await page.mouse.click(box.x + mid.x, box.y + mid.y);
  const added = await ev(() => window.__chars.selNode);
  ok('Add a node puts a new node where you click, on the part you clicked', await ev((id) => window.__chars.rig().nodes.find((n) => n.id === id)?.parent, added) === 'forearm_L');
  await page.fill(`[data-node="${added}"] input`, 'hand L');
  await page.press(`[data-node="${added}"] input`, 'Enter');
  ok('naming a node like a layer attaches the layer', await ev((id) => window.__chars.rigView().pieces.hand_L.bone === id, added));
  // Drop the new node on the chest node: it moves with the chest.
  const from = await ev((id) => window.__chars.stage.worldToScreen(window.__chars.rigView().pivots[id]), added);
  const to = await ev(() => window.__chars.stage.worldToScreen(window.__chars.rigView().pivots.waist));
  const before = await ev((id) => ({ ...window.__chars.rigView().pivots[id] }), added);
  await page.mouse.move(box.x + from.x, box.y + from.y); await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 });
  ok('dragging over another node offers to connect', (await page.textContent('.chars-marks')).includes('Connect to'));
  await page.mouse.up();
  ok('dropping a node on another connects them', await ev((id) => window.__chars.rig().nodes.find((n) => n.id === id).parent, added) === 'chest');
  const after = await ev((id) => window.__chars.rigView().pivots[id], added);
  ok('the dropped node stays where it was', Math.hypot(after.x - before.x, after.y - before.y) < 0.5, JSON.stringify([before, after]));
  await page.screenshot({ path: `${out}/characters-rig.png` });
  // Delete it: its layer goes back to the node above.
  await page.click(`[data-node="${added}"] .muted`);
  await page.keyboard.press('Delete');
  ok('Delete removes a node; its layer moves with the node above', await ev((id) => !window.__chars.rig().nodes.some((n) => n.id === id) && window.__chars.rigView().pieces.hand_L.bone === 'chest', added));
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
  // Detail: Simple drops the elbows, knees, hands and feet; their layers move with the node above.
  await page.click('[data-detail="low"]');
  ok('Simple: fewer nodes, the hand layer moves with the upper arm', await ev(() => { const r = window.__chars.rig(); return !r.nodes.some((n) => n.id === 'elbow_L') && window.__chars.rigView().pieces.hand_L.bone === 'upperarm_L'; }));
  await page.click('[data-detail="high"]');
  ok('Complex: every node is back, and the hand layer is on L hand again', await ev(() => window.__chars.rig().nodes.some((n) => n.id === 'wrist_L') && window.__chars.rigView().pieces.hand_L.bone === 'hand_L'));
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  // Starting rigs.
  await page.click('[data-kind="four"]');
  ok('4 legs: a starting rig with a tail and paws', await ev(() => window.__chars.rig().nodes.some((n) => n.name === 'Tail') && window.__chars.rig().nodes.some((n) => n.name === 'L front paw')));
  await page.keyboard.press('Control+z');
  ok('undo goes back to the human rig', await ev(() => (window.__chars.rig().kind ?? 'human') === 'human' && window.__chars.rig().nodes?.some((n) => n.name === 'L hand') !== false));

}

// --- act: a photo of a known pose, the dots, the angle, more poses, playing -------------------
if (want('act')) {
  // The "photo": the placeholder drawn in a known pose on a grey wall (scripts/fixtures/pose-photo.png:
  // shoulder_L -100, elbow_L -30, shoulder_R 35, hip_R 25, knee_R -40). A fixed file, so the check never depends
  // on how the tracker reads a freshly drawn picture.
  const photoFile = new URL('./fixtures/pose-photo.png', import.meta.url).pathname;
  await page.click('#chars-back');
  await page.waitForSelector('.sb-empty, .sb-panel');
  if (await page.locator('#sb-first').count()) await page.click('#sb-first');
  await page.dblclick('.sb-panel >> nth=0 >> .sb-head');
  await page.waitForSelector('#act-photos');
  await page.screenshot({ path: `${out}/act-empty.png` });
  await choose(page, '#act-photos', photoFile);
  await page.waitForSelector('.act-dot', { timeout: 60000 });
  await page.waitForTimeout(800);
  const pose = await ev(() => { const a = window.__act, m = a.p.moments[a.cur]; return Object.values(m.poses)[0]; });
  const a = pose.angles, r = (n) => Math.round(n ?? 0);
  console.log(`    acted: ${pose.view}${pose.flip ? ' flipped' : ''}, shoulder_L ${r(a.shoulder_L)} elbow_L ${r(a.elbow_L)} shoulder_R ${r(a.shoulder_R)} knee_R ${r(a.knee_R)}`);
  ok('the app finds the body and shows its dots', await page.locator('.act-dot').count() >= 15);
  ok('the character copies the photo (raised arm within 25°)', near(a.shoulder_L ?? 0, -100, 25) && near(a.shoulder_R ?? 0, 35, 25), JSON.stringify(a));
  ok('a front-facing photo gives the front drawing', pose.view === 'front' && !pose.flip);
  await page.screenshot({ path: `${out}/act-take.png` });
  // Drag the left elbow dot down: the upper arm and forearm follow.
  const armBefore = a.shoulder_L ?? 0;
  const dot = await page.locator('[data-dot="13"]').boundingBox();
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2); await page.mouse.down();
  await page.mouse.move(dot.x + dot.width / 2 + 10, dot.y + dot.height / 2 + 90, { steps: 6 }); await page.mouse.up();
  const armNow = () => ev(() => { const a = window.__act, m = a.p.moments[a.cur]; return Object.values(m.poses)[0].angles.shoulder_L; });
  const after = await armNow();
  ok('dragging a dot changes the pose', Math.abs(after - armBefore) > 10, `${armBefore} → ${after}`);
  await page.keyboard.press('Control+z');
  ok('undo puts the dot back', near(await armNow(), armBefore, 0.5));
  // Choose the angle and flip by hand.
  await page.click('[data-view="quarter"]');
  ok('choosing 3/4 by hand draws the 3/4 drawing', await ev(() => { const a = window.__act, m = a.p.moments[a.cur]; return Object.values(m.poses)[0].view; }) === 'quarter');
  await page.click('#act-flip');
  ok('Flip flips it', await ev(() => { const a = window.__act, m = a.p.moments[a.cur]; return Object.values(m.poses)[0].flip; }) === true);
  await page.click('[data-view="front"]'); await page.click('#act-flip');
  // A second pose from the same photo, a different hold, then Play.
  await choose(page, '#act-next', photoFile);
  await page.waitForFunction(() => window.__act.p.moments.length === 2, null, { timeout: 60000 });
  ok('+ Act the next pose adds pose 2 and selects it', await ev(() => window.__act.cur) === 1 && await page.locator('.act-pose').count() === 2);
  await page.fill('#act-hold', '1.5'); await page.keyboard.press('Tab');
  ok('a pose holds as long as you say', await ev(() => window.__act.p.moments[1].hold) === 1.5);
  ok('the panel is as long as its holds and moves', /2\.5s in all/.test(await page.textContent('.act-total')), await page.textContent('.act-total'));
  await page.click('#act-play');
  await page.waitForTimeout(400);
  ok('Play runs from pose to pose', await ev(() => window.__act.playing === true));
  await page.click('#act-play');
  // Save as a pose, and use it from My poses.
  await page.click('#act-save-pose');
  await page.waitForTimeout(400);
  ok('Save as a pose adds to My poses', await ev(() => window.__project().poses.length) === 1);
  await page.click('.act-pose >> nth=0 >> .act-pose-pick');
  await page.click('#act-my-poses summary');
  await page.click('#act-my-poses .pose-row');
  ok('a saved pose can be put on another pose', await ev(() => { const ms = window.__act.p.moments, k = Object.keys(ms[0].poses)[0]; return JSON.stringify(ms[0].poses[k].angles) === JSON.stringify(ms[1].poses[k].angles); }));
  // A photo from the waist up: the legs keep their pose, and no leg dots are shown.
  const legsBefore = await ev(() => { const a = window.__act, ms = a.p.moments, k = Object.keys(ms[0].poses)[0]; return JSON.stringify([ms.at(-1).poses[k].angles.knee_L, ms.at(-1).poses[k].angles.hip_R]); });
  await page.click('.act-pose >> nth=1 >> .act-pose-pick');
  await choose(page, '#act-next', new URL('./fixtures/half-photo.png', import.meta.url).pathname);
  await page.waitForFunction(() => window.__act.p.moments.length === 3, null, { timeout: 60000 });
  await page.waitForTimeout(500);
  ok('a photo from the waist up says so', await page.locator('#act-half').count() === 1);
  ok('it shows no dots for parts outside the photo', await page.locator('[data-dot="25"], [data-dot="27"]').count() === 0);
  ok('and the legs keep the pose they had', await ev(() => { const a = window.__act, ms = a.p.moments, k = Object.keys(ms[2].poses)[0]; return JSON.stringify([ms[2].poses[k].angles.knee_L, ms[2].poses[k].angles.hip_R]); }) === legsBefore, legsBefore);
  await page.screenshot({ path: `${out}/act-half.png` });
  // Back on the storyboard, the panel shows its character.
  await page.click('#act-back');
  await page.waitForFunction(() => document.querySelector('.sb-panel img')?.src.startsWith('data:image/jpeg'), null, { timeout: 15000 });
  ok('the storyboard panel now shows the acted character', /3 poses/.test(await page.textContent('.sb-panel >> nth=0 >> .sb-head')));
  await page.screenshot({ path: `${out}/storyboard-acted.png` });
}

// --- save: reload keeps the scene and its photos ------------------------------------------
if (want('save')) {
  await page.waitForTimeout(900);
  const snap = () => ev(() => { const p = window.__project(); return JSON.stringify({ chars: p.characters.map((c) => c.name), poses: p.poses.length, assets: [...p.assets.keys()].sort(), panels: p.storyboard.panels.map((x) => [x.cast?.length ?? 0, x.moments?.length ?? 0]), quarterFaces: p.characters[0]?.data.rig.views.quarter?.faces ?? null }); });
  const a = await snap();
  await page.reload();
  await page.waitForSelector('.sb-panel, .act, .chars');
  const b = await snap();
  ok('reload keeps characters, panels, poses and photos', a === b, `\n   before ${a}\n   after  ${b}`);
  const zip = await ev(async () => {
    const p = await import('/src/project/project.ts'), s = await import('/src/project/store.ts');
    const files = s.fromZip(s.toZip(p.projectToFiles(window.__project())));
    const back = await p.filesToProject(files);
    return { paths: [...files.keys()].sort(), photos: [...back.assets.keys()].filter((k) => k.startsWith('photos/')).length, panels: back.storyboard?.panels.length };
  });
  const acted = want('act') ? 1 : 0; // photos exist only once a panel was acted out
  ok('project zip round trip, photos included', zip.photos >= acted && zip.panels >= acted, JSON.stringify(zip));
  console.log('    project files:\n      ' + zip.paths.join('\n      '));
}

console.log(errors.length ? `\nPAGE ERRORS:\n${[...new Set(errors)].slice(0, 10).join('\n')}` : '\nNo page errors.', fail ? `${fail} FAILED` : 'All passed.');
await context.close();
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
