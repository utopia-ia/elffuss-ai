// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// How many clicks each tool asks for, counted as a person would make them. After
// the input is chosen (picked, which the browser's own dialog does), the test
// clicks the primary button only when the page waits for it, and counts:
//
//   first visit (fresh profile): 1 click, the button that says what it downloads
//     and its size, and it downloads and runs in one go;
//   second visit (the model is in the store): 0 clicks, choosing the input runs it;
//   the result: its download button is on screen when the result appears, and
//     one click saves it.
//
// In ocr, a folder chosen on the second visit is read at once too. With
// ELFFUSS_AI_SCREENSHOTS=1 the first-visit page with its input chosen is saved in
// $ELFFUSS_AI_CACHE/logs (never in the repo).
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseVariant } from '../../../sdk/core/device.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatMB } from '../../../scripts/lib/pages.mjs';

const FIX = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const RUN_TIMEOUT = 20 * 60 * 1000;
/** The page waits for a click when its primary button stays enabled this long with no result. */
const QUIET = 2500;

const APPS = {
  cutout: { input: 'main label.drop input[type="file"]', file: 'cutout/foto.jpg', save: 'main section.result [data-action="download"]' },
  depth: { input: 'main label.drop input[type="file"]', file: 'depth/foto.jpg', save: 'main section.result [data-action="download-color"]' },
  detect: { input: 'main label.drop input[type="file"]', file: 'detect/foto.jpg', save: 'main section.result [data-action="download-png"]' },
  ocr: { input: 'input[data-input="files"]', file: 'ocr/factura.png', save: 'main section.result [data-action="download-zip"]' },
};

/** Results so far: runs of the site's task, or the end of the OCR queue. */
function results(page, site) {
  return page.evaluate(name => {
    const e = globalThis.__elffuss || {};
    if (name === 'ocr') return e.ocr?.done ? 1 : 0;
    return e[name]?.runs ?? 0;
  }, site);
}

/**
 * Click the primary button whenever the page waits for it, until a result
 * arrives; returns the clicks made, or throws with what the page says.
 */
async function clicksToResult(page, site) {
  let clicks = 0;
  for (;;) {
    const before = await results(page, site);
    const state = await page.evaluate(async ([name, quiet, timeout]) => {
      const e = () => globalThis.__elffuss || {};
      const count = () => (name === 'ocr' ? (e().ocr?.done ? 1 : 0) : (e()[name]?.runs ?? 0));
      const start = count(), errors = e().errors?.length ?? 0, t0 = performance.now();
      let since = performance.now();
      for (;;) {
        await new Promise(r => setTimeout(r, 100));
        if (count() > start) return 'done';
        if ((e().errors?.length ?? 0) > errors) return 'error: ' + e().errors.at(-1) + ' · ' + document.querySelector('main p.status')?.textContent;
        const p = document.querySelector('main button.primary');
        const busy = e().ocr?.reading || !document.querySelector('main progress')?.hidden;
        if (!p || p.disabled || busy) since = performance.now();
        else if (performance.now() - since > quiet) return 'waiting';
        if (performance.now() - t0 > timeout) return 'timeout';
      }
    }, [site, QUIET, RUN_TIMEOUT]);
    if (state === 'done') return clicks;
    if (state !== 'waiting') throw new Error(`${state} after ${clicks} clicks (results before: ${before})`);
    if (clicks >= 4) throw new Error('still waiting after 4 clicks');
    await page.click('main button.primary');
    clicks++;
  }
}

/** The result's download button is on screen as the result appears; one click saves it. */
async function saveInOneClick(t, page, sel, label) {
  await page.waitForSelector(sel, { state: 'visible', timeout: 30000 });
  const onScreen = await page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { ok: r.top >= 0 && r.bottom <= innerHeight + 1 && r.height > 0, top: Math.round(r.top), bottom: Math.round(r.bottom), view: innerHeight, scroll: Math.round(scrollY) };
  }, sel);
  t.ok(onScreen.ok, `${label}: the result's download button is on screen without scrolling (${JSON.stringify(onScreen)})`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(sel)]);
  t.ok(Boolean(dl.suggestedFilename()), `${label}: one click saves the result (${dl.suggestedFilename()})`);
  return 1;
}

export default [
  {
    name: 'clicks: first visit 1 click (download and run), second visit 0, the result saved in 1',
    sites: ['cutout', 'depth', 'detect', 'ocr'],
    async run(t, site) {
      const app = APPS[site.site];
      const s = t.strings[site.site].es;
      const m = t.registry.models[site.models[0]];
      const size = `${formatMB(chooseVariant(m, 'auto', t.probe).variant.bytes, 'es')} MB`;
      const ctx = await t.newContext();

      // First visit: nothing in the store.
      let page = await t.open(ctx, site, '/');
      await page.setInputFiles(app.input, join(FIX, app.file));
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
      const label = await page.textContent('main button.primary');
      t.equal(label, fill(s['action.downloadAndRun'], { size }), 'first visit: one button, with the action and the exact size');
      const privacy = await page.textContent('[data-role="model"]');
      t.ok(privacy.includes(s['privacy.download']) && privacy.includes(size.replace(' MB', '')), `first visit: the privacy line and the size are on screen (${privacy})`);
      t.equal(t.hubTotal(), 0, 'first visit: nothing downloaded before the click');
      if (process.env.ELFFUSS_AI_SCREENSHOTS === '1') await page.screenshot({ path: join(t.cache, 'logs', `clicks-${site.site}-first-visit-${t.config}.png`) });
      let first;
      try { first = await clicksToResult(page, site.site); } catch (err) { t.ok(false, `first visit: ${err.message}`); return; }
      t.equal(first, 1, 'first visit: clicks after choosing the input');
      const save1 = await saveInOneClick(t, page, app.save, 'first visit');

      // Second visit: the model is in the store; choosing the input runs it.
      page = await t.open(ctx, site, '/');
      await page.waitForFunction(x => document.querySelector('main button.primary').textContent === x, s['action.run'], { timeout: 30000 }).catch(() => {});
      t.equal(await page.textContent('main button.primary'), s['action.run'], 'second visit: the button no longer downloads');
      await page.setInputFiles(app.input, join(FIX, app.file));
      let second;
      try { second = await clicksToResult(page, site.site); } catch (err) { t.ok(false, `second visit: ${err.message}`); return; }
      t.equal(second, 0, 'second visit: clicks after choosing the input');
      const save2 = await saveInOneClick(t, page, app.save, 'second visit');

      // Another input on the same page runs at once too.
      if (site.site !== 'ocr') {
        const n = await results(page, site.site);
        await page.setInputFiles(app.input, join(FIX, app.file));
        await page.waitForFunction(([name, k]) => (globalThis.__elffuss?.[name]?.runs ?? 0) > k, [site.site, n], { timeout: RUN_TIMEOUT });
        t.ok(true, 'a second input on the same page runs with no click');
      }
      t.note(`first visit: ${first} click + ${save1} to save; second visit: ${second} clicks + ${save2} to save`);
      t.noPageErrors();
      await t.noCsp(page);
    },
  },
  {
    name: 'clicks: ocr, a folder chosen once the model is here is read at once',
    sites: ['ocr'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      let page = await t.open(ctx, site, '/');
      await page.setInputFiles('input[data-input="files"]', join(FIX, 'ocr/factura.png'));
      const first = await clicksToResult(page, 'ocr');
      t.equal(first, 1, 'first visit: one click');
      page = await t.open(ctx, site, '/');
      await page.setInputFiles('input[data-input="folder"]', join(FIX, 'ocr/carpeta'));
      let clicks;
      try { clicks = await clicksToResult(page, 'ocr'); } catch (err) { t.ok(false, `folder: ${err.message}`); return; }
      t.equal(clicks, 0, 'a folder: no click, the queue starts at once');
      const items = await page.evaluate(() => globalThis.__elffuss.ocr.items().filter(i => i.status === 'ok').length);
      t.ok(items > 1, `the folder was read (${items} files read)`);
      t.note(`folder: ${clicks} clicks, ${items} files read`);
      t.noPageErrors();
    },
  },
];
