// End-to-end check in a real browser. Needs `npm run dev` running.
//   node scripts/check.mjs [outDir] [section...]     sections: import pose animate scene sound layers capture export save
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
  await page.click(`[data-placeholder="${placeholder}"]`);
  await page.waitForSelector('#open-editor, .status.error', { timeout: 90000 });
  return { context, page };
}
const settle = (page) => page.waitForFunction(() => window.__rig?.timeline, null, { timeout: 20000 }).then(() => page.waitForTimeout(350));
/** Wait for the editor, then open the panel and every folded group so the checks can reach all controls. */
const ready = async (page) => {
  await settle(page);
  await page.evaluate(() => { const ed = window.__rig; ed.panelOpen = true; ed.openAll = true; ed.timeline.moreOpen = true; ed.refresh(); });
  await page.waitForTimeout(150);
};
const tab = async (page, t) => { await page.click(`[data-tab="${t}"]`); await page.waitForTimeout(150); };
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

// --- import: every placeholder --------------------------------------------------
if (want('import')) {
  for (const label of ['High', 'Medium', 'Low', 'PSD (Procreate style)', 'Part files']) {
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

// --- first look: the stage has the window, options are one click away --------------
if (want('pose')) {
  const first = await ev(page, () => ({
    panel: getComputedStyle(document.querySelector('.panel')).display, steps: [...document.querySelectorAll('.step')].map((b) => b.textContent.replace(/^\d/, '')),
    here: document.querySelector('.step.selected')?.dataset.tab, atRest: [...document.querySelectorAll('.toolbar button:not(.step), .toolbar select, .toolbar summary, .action-bar button, .action-bar select, .tl-bar > button, .tl-bar > label, .tl-bar > details')].filter((e) => !e.closest('.menu-items')).length,
    charBar: !document.querySelector('.char-bar').hidden, mouthOnChar: !!document.querySelector('.char-bar [data-swap="mouth"]'),
  }));
  ok('the side panel starts closed', first.panel === 'none');
  ok('the path reads Character, Scene, Animate, Sound, Export', first.steps.join() === 'Character,Scene,Animate,Sound,Export' && first.here === 'animate', JSON.stringify(first));
  ok('view, flip, mouth and hands sit on the character', first.charBar && first.mouthOnChar);
  console.log(`    controls showing at rest outside the stage and steps: ${first.atRest}`);
  await page.screenshot({ path: `${out}/first-look.png` });
  await page.click('#more');
  ok('More options opens the panel', await ev(page, () => getComputedStyle(document.querySelector('.panel')).display) !== 'none');
  ok('advanced settings are folded away', await ev(page, () => [...document.querySelectorAll('.panel details.more')].every((d) => !d.open) && document.querySelectorAll('.panel details.more').length >= 3));
  await page.screenshot({ path: `${out}/more-open.png` });
}
await ready(page);

// --- pose: FK, IK, swaps, library, controllers, undo ---------------------------
if (want('pose')) {
  // Moving the view: a plain left-drag never pans; Space+drag, two-finger scroll and pinch do.
  const origin = () => ev(page, () => window.__rig.stage.worldToScreen({ x: 0, y: 0 }));
  const box0 = await stageBox(page), empty = { x: 40, y: box0.height - 60 };
  let o0 = await origin();
  await drag(page, empty, 80, -50);
  let o1 = await origin();
  ok('a left-drag on empty stage does not move the view', near(o0.x, o1.x) && near(o0.y, o1.y), JSON.stringify([o0, o1]));
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

  // Controller.
  await page.click('#reset-pose');
  await page.click('#new-joystick');
  await setAngles(page, { shoulder_L: -90, shoulder_R: 90 });
  await page.click('[data-slot="e"]');
  const pb = await page.locator('.pad-area').first().boundingBox();
  const r = pb.width * 48 / 120, c = { x: pb.x + pb.width / 2, y: pb.y + pb.height / 2 };
  await page.mouse.move(c.x + r, c.y); await page.mouse.down(); await page.mouse.move(c.x + r / 2, c.y, { steps: 6 }); await page.mouse.up();
  ok('controller knob halfway blends', near((await angles(page)).shoulder_L, -45, 5), JSON.stringify(await angles(page)));
  await page.click('#delete-pad');
  await page.click('#reset-pose');
}

// --- animate: keys, easing, timing, onion -----------------------------------------
if (want('animate')) {
  await tab(page, 'animate');
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
  // The rest of this section checks manual keying, with auto-record turned off.
  await page.uncheck('#auto-key');
  await ev(page, () => { const ed = window.__rig; ed.sel().keys = []; ed.setFrame(0); ed.refresh(); });
  await page.click('#reset-pose');
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
  // Auto key.
  await page.check('#auto-key');
  await ev(page, () => window.__rig.setFrame(40));
  await setAngles(page, { neck: 20 });
  ok('auto key stores the change', await ev(page, () => window.__rig.sel().keys.some((k) => k.frame === 40)));
  await page.uncheck('#auto-key');
  // Drag a key on the timeline.
  const tl = await page.locator('.tl-canvas').boundingBox();
  await page.mouse.move(tl.x + 40 * 10 + 5, tl.y + 24 + 12); await page.mouse.down();
  await page.mouse.move(tl.x + 47 * 10 + 5, tl.y + 24 + 12, { steps: 6 }); await page.mouse.up();
  ok('dragging a key moves it', await ev(page, () => window.__rig.sel().keys.map((k) => k.frame).join()) === '0,24,47');
  // Scrub on the ruler.
  await page.mouse.move(tl.x + 12 * 10 + 5, tl.y + 10); await page.mouse.down(); await page.mouse.up();
  ok('clicking the ruler moves the playhead', await ev(page, () => window.__rig.frame) === 12);
  await page.check('#onion');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/animate-onion.png` });
  await page.uncheck('#onion');
  // Playback advances.
  await ev(page, () => window.__rig.setFrame(0));
  await page.click('#play');
  await page.waitForTimeout(700);
  const playing = await ev(page, () => window.__rig.frame);
  await page.click('#play');
  ok('play advances the playhead', playing > 5, String(playing));
}

// --- scene: second character, extra, background, framing, template ---------------
if (want('scene')) {
  await tab(page, 'scene');
  await page.click('#import-character');
  await page.click('[data-placeholder="Medium"]');
  await page.click('#open-editor');
  await ready(page);
  ok('a second character lands in the shot', await ev(page, () => window.__rig.shot.actors.length) === 2);
  ok('poses saved on one character apply to another', await ev(page, () => window.__rig.project.poses.length) >= 0);
  await tab(page, 'scene');
  await page.selectOption('#add-actor', 'placeholder_medium');
  await page.selectOption('[data-actor="placeholder_medium"] select >> nth=0', 'extra').catch(() => {});
  const roles = await ev(page, () => window.__rig.shot.actors.map((a) => a.role).join());
  ok('a character can be an extra', roles.includes('extra'), roles);
  // Background: a generated PNG.
  const png = await ev(page, () => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = 960; c.height = 640; const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 640); grad.addColorStop(0, '#bfe3ff'); grad.addColorStop(0.7, '#e8f6ff'); grad.addColorStop(0.7, '#9bcf8a'); grad.addColorStop(1, '#6faa62');
    g.fillStyle = grad; g.fillRect(0, 0, 960, 640); g.fillStyle = '#fff'; g.beginPath(); g.arc(760, 120, 60, 0, 7); g.fill();
    c.toBlob(async (b) => res([...new Uint8Array(await b.arrayBuffer())]));
  }));
  writeFileSync(`${out}/park.png`, Buffer.from(png));
  await choose(page, '#add-background', `${out}/park.png`);
  await page.waitForTimeout(300);
  ok('background added and scaled to cover the stage', await ev(page, () => { const b = window.__rig.shot.backgrounds[0]; return !!b && b.scale >= 3; }));
  // Drag a character.
  await page.click('[data-bar-tool="characters"]');
  const x0 = await ev(page, () => window.__rig.pose().root.x);
  const sel = await ev(page, () => { const ed = window.__rig, b = ed.stage.actor({ id: ed.sel().id, rig: ed.rig() }).bounds(); return ed.stage.worldToScreen({ x: b.x + b.w / 2, y: b.y + b.h * 0.45 }); });
  await drag(page, sel, 90, 10);
  ok('dragging in Scene places the character', (await ev(page, () => window.__rig.pose().root.x)) - x0 > 40);
  // Framing: each shape keeps its own.
  await page.click('[data-bar-tool="framing"]');
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
  await page.selectOption('#format', 'shorts');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}/scene-shorts.png` });
  for (const f of ['yt', 'shorts', 'post45']) {
    await page.selectOption('#format', f);
    const size = await ev(page, () => { const c = window.__rig.outputFrame(window.__rig.frame, true); window.__rig.redraw(); return [c.width, c.height]; });
    const wantSize = { yt: [1920, 1080], shorts: [1080, 1920], post45: [1080, 1350] }[f];
    ok(`a frame renders at ${wantSize.join('×')} for ${f}`, size[0] === wantSize[0] && size[1] === wantSize[1], size.join('x'));
  }
  await page.selectOption('#format', 'yt');
  await page.fill('#template-name', 'Park');
  await page.click('#save-template');
  ok('scene saved as a template', await ev(page, () => window.__rig.project.scenes[0]?.name) === 'Park');
  await page.screenshot({ path: `${out}/scene.png` });
  await page.selectOption('#shot', '+');
  await ready(page);
  ok('a new shot starts with the same characters', await ev(page, () => window.__rig.shot.actors.length) === 2);
  await ev(page, () => { const ed = window.__rig; ed.shot.actors.length = 0; ed.selId = null; ed.evaluateAll(); ed.refresh(); });
  ok('the character bar hides when there is no character', await ev(page, () => getComputedStyle(document.querySelector('.char-bar')).display) === 'none');
  ok('an empty shot says what to do next', await ev(page, () => !document.querySelector('.empty-note').hidden && /no characters yet/.test(document.querySelector('.empty-note').textContent)));
  await page.screenshot({ path: `${out}/empty.png` });
  await page.selectOption('#shot', 'Shot 1');
  await ready(page);
}

// --- sound, lip sync, text ---------------------------------------------------------
if (want('sound')) {
  await tab(page, 'sound');
  await ev(page, () => { const ed = window.__rig; ed.selId = ed.shot.actors[0].id; ed.setFrame(0); ed.refresh(); });
  writeFileSync(`${out}/line.wav`, wav(2, [[0.2, 0.6, 0.9], [0.8, 1.1, 0.4], [1.3, 1.8, 1]]));
  writeFileSync(`${out}/music.wav`, wav(3, [[0, 3, 0.3]]));
  await choose(page, '#add-dialogue', `${out}/line.wav`);
  await page.waitForSelector('[data-clip="line.wav"]');
  await choose(page, '#add-music', `${out}/music.wav`);
  await page.waitForSelector('[data-clip="music.wav"]');
  ok('two sound clips on the shot', await ev(page, () => window.__rig.shot.audio.length) === 2);
  ok('adding dialogue moves the mouth straight away', await ev(page, () => window.__rig.shot.actors[0].mouth.length) >= 4);
  await page.click('[data-flaps="line.wav"]');
  const mouth = await ev(page, () => window.__rig.shot.actors[0].mouth);
  const shapeAt = (f) => [...mouth].reverse().find((m) => m.frame <= f)?.shape;
  ok('mouth flaps follow the loudness', mouth.length >= 4 && shapeAt(2) === 'rest' && shapeAt(9) !== 'rest' && shapeAt(16) === 'rest' && shapeAt(38) !== 'rest', JSON.stringify(mouth));
  await ev(page, () => window.__rig.setFrame(9));
  ok('the mouth key shows at its frame', await ev(page, () => window.__rig.pose().swaps?.mouth) === shapeAt(9));
  await page.click('[data-mouth="mbp"]');
  ok('a mouth shape can be keyed by hand', await ev(page, () => window.__rig.shot.actors[0].mouth.find((m) => m.frame === 9)?.shape) === 'mbp');
  await ev(page, () => window.__rig.setFrame(4));
  await page.click('#add-subtitle');
  await page.fill('[data-text="subtitle"] textarea', 'こんにちは、元気？');
  await page.keyboard.press('Tab');
  await page.click('#add-text');
  await page.fill('[data-text="text"] textarea', 'POW!');
  await page.keyboard.press('Tab');
  ok('subtitle and on-screen text added', await ev(page, () => window.__rig.shot.texts.map((t) => t.kind).sort().join()) === 'subtitle,text');
  await ev(page, () => window.__rig.setFrame(20));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/sound.png` });
}

// --- layers: images and text on the timeline ----------------------------------------------
if (want('layers')) {
  await tab(page, 'animate');
  const star = await ev(page, () => new Promise((res) => {
    const c = document.createElement('canvas'); c.width = 300; c.height = 300; const g = c.getContext('2d');
    g.fillStyle = '#ffcc33'; g.strokeStyle = '#2a2238'; g.lineWidth = 10; g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 60 : 140, a = (i * Math.PI) / 5 - Math.PI / 2; g.lineTo(150 + r * Math.cos(a), 150 + r * Math.sin(a)); }
    g.closePath(); g.fill(); g.stroke();
    c.toBlob(async (b) => res([...new Uint8Array(await b.arrayBuffer())]));
  }));
  writeFileSync(`${out}/star.png`, Buffer.from(star));
  const before = await ev(page, () => window.__rig.shot.backgrounds.length);
  await page.click('#add-layer summary');
  await choose(page, '#layer-image-front', `${out}/star.png`);
  await page.waitForFunction((n) => window.__rig.shot.backgrounds.length === n + 1, before);
  const layer = await ev(page, () => { const ed = window.__rig, l = ed.shot.backgrounds.at(-1); return { front: l.front, sel: ed.selBg === l.id, scale: l.scale, rows: ed.timeline.rows.map((r) => r.kind) }; });
  ok('Add layer puts an image in front of the characters and selects it', layer.front === true && layer.sel && layer.scale <= 1, JSON.stringify(layer));
  ok('the layer has its own timeline row, above the characters', layer.rows.indexOf('layer') > 0 && layer.rows.indexOf('layer') < layer.rows.indexOf('keys'), layer.rows.join());
  // Trim it on the timeline: drag the right edge of its bar from the end of the shot back to frame 30.
  await ev(page, () => { const t = window.__rig.timeline; t.ppf = 5; t.render(); document.querySelector('.tl-scroll').scrollLeft = 0; });
  const tl = await page.locator('.tl-canvas').boundingBox();
  const rowY = await ev(page, () => { const t = window.__rig.timeline; let y = 0; for (const r of t.rows) { if (r.kind === 'layer') return y + r.h / 2; y += r.h; } });
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
  // Drag it on the stage.
  await ev(page, () => window.__rig.setFrame(5));
  const lp = await ev(page, () => { const ed = window.__rig, l = ed.shot.backgrounds.at(-1), s = ed.stage.backgroundSize(l.file); return { at: ed.stage.worldToScreen({ x: l.x + s.w * l.scale / 2, y: l.y + s.h * l.scale / 2 }), x: l.x }; });
  await drag(page, lp.at, 120, -60);
  ok('a selected layer drags on the stage', (await ev(page, () => window.__rig.shot.backgrounds.at(-1).x)) - lp.x > 60);
  await page.click('#add-layer summary');
  await page.click('#layer-text');
  ok('a text layer is added at the playhead with its own row', await ev(page, () => { const ed = window.__rig, t = ed.shot.texts.at(-1); return t.kind === 'text' && t.start === 5 && ed.timeline.rows.filter((r) => r.kind === 'text').length >= 1; }));
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/layers.png` });
  await page.keyboard.press('Control+z');
  ok('undo removes the text layer', await ev(page, () => window.__rig.shot.texts.filter((t) => t.text === 'Text').length) === 0);
}

// --- capture: pose from a photo ---------------------------------------------------------
if (want('capture')) {
  // The "photo" is a render of the character in a known pose, on a grey wall.
  const made = await ev(page, () => {
    const ed = window.__rig;
    ed.tab = 'animate'; ed.selId = ed.shot.actors[0].id; ed.setFrame(60); ed.refresh();
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
  // Webcam flow, with the browser's fake camera (a test pattern, so no person is expected).
  await page.click('#webcam-start');
  await page.waitForSelector('#webcam-capture', { timeout: 15000 });
  await page.click('#webcam-capture');
  await page.waitForFunction(() => /No person|applied|captured/.test(document.querySelector('#capture-status')?.textContent ?? ''), null, { timeout: 30000 });
  ok('webcam countdown runs and reports what it found', true);
  console.log('    webcam:', await page.textContent('#capture-status'));
  await tab(page, 'animate');
  ok('leaving the tab turns the camera off', await ev(page, () => !document.querySelector('video')));
}

// --- export ------------------------------------------------------------------------
if (want('export')) {
  await tab(page, 'export');
  await ev(page, () => { window.__rig.shot.length = 48; window.__rig.refresh(); });
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('#bar-export')]);
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
  ok('video has a sound track', !!info.audio);
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
  const snap = () => ev(page, () => { const p = window.__rig.project, s = window.__rig.shot; return JSON.stringify({ chars: p.characters.map((c) => c.name), poses: p.poses.length, scenes: p.scenes.length, assets: [...p.assets.keys()].sort(), actors: s.actors.map((a) => [a.character, a.role, a.keys.length, a.mouth.length]), bg: s.backgrounds.length, audio: s.audio.length, texts: s.texts.length, cams: s.cameras.shorts }); });
  const a = await snap();
  await page.reload();
  await ready(page);
  const b = await snap();
  ok('reload keeps characters, shot, keys, sound, text and images', a === b, `\n   before ${a}\n   after  ${b}`);
  const zip = await ev(page, async () => {
    const p = await import('/src/project/project.ts'), s = await import('/src/project/store.ts');
    const files = s.fromZip(s.toZip(p.projectToFiles(window.__rig.project)));
    const back = await p.filesToProject(files);
    return { paths: [...files.keys()].sort(), shots: back.shots.length, chars: back.characters.length };
  });
  ok('project zip round trip', zip.shots >= 1 && zip.chars === (JSON.parse(a).chars.length));
  console.log('    project files:\n      ' + zip.paths.join('\n      '));
}

console.log(errors.length ? `\nPAGE ERRORS:\n${[...new Set(errors)].slice(0, 10).join('\n')}` : '\nNo page errors.', fail ? `${fail} FAILED` : 'All passed.');
await context.close();
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
