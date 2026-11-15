// Writes the placeholder as Procreate-style PSDs (one per view, `_line` over
// `_fill` layers) by importing the High SVG in the running dev app.
//   npm run dev   (in another terminal), then   node scripts/make-placeholder-psd.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');

const APP = process.env.APP_URL ?? 'http://localhost:5173/';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(APP);
await page.click('[data-placeholder="High"]');
await page.click('#open-editor');
await page.waitForFunction(() => window.__rig?.timeline);
await page.waitForTimeout(300);
for (const view of ['front', 'side']) {
  const b64 = await page.evaluate((v) => {
    const ed = window.__rig;
    const bytes = new Uint8Array(window.__exportViewPsd(ed.entry(ed.sel()).data.imp, v));
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, view);
  const file = fileURLToPath(new URL(`../public/placeholder/char_placeholder_${view}.psd`, import.meta.url));
  writeFileSync(file, Buffer.from(b64, 'base64'));
  console.log('Wrote', file);
}
await browser.close();
