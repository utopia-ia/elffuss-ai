// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The image site through its real page (a description in, the primary button, a
// picture out), validating the picture and not only that it appears:
//  - the astronaut of the model card, seed 42, two steps: its PNG, reduced to
//    256 × 256 by 4 × 4 averages, against golden-astronaut-256.png (the same
//    reduction of the WebGPU result, which matches the diffusers reference in
//    composition; see SOURCES.json): PSNR of at least MIN_PSNR;
//  - the stages the page shows (encode, each step, decode), the backend, the seed
//    and the size it reports, the PNG download and the history entry;
//  - another variation: a new seed, a different picture, nothing downloaded again;
//  - without WebGPU: the page says so before anything is downloaded, and the
//    button stays off.
//
// ELFFUSS_AI_IMAGE_GOLDEN=write (configuration A) writes the golden again from
// this run and prints its sha256 for tests/fixtures/SOURCES.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodePng, encodePngSamples } from '../../../sdk/core/png.js';
import { canStartFromImage } from '../../../sdk/text-to-image/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GOLDEN = join(ROOT, 'tests', 'fixtures', 'text-to-image', 'golden-astronaut-256.png');
const PROMPT = 'a tiny astronaut hatching from an egg on the moon';
/**
 * Least PSNR, in dB, of the reduced picture against the golden. Two WebGPU runs
 * give the same picture to within rounding; this leaves room for another
 * adapter's float16 arithmetic, never for another picture (a different seed or
 * prompt gives about 10 dB).
 */
export const MIN_PSNR = 30;

/** RGB of a picture ({ width, height, channels, data }) reduced by averages of `k` × `k` pixels. */
export function reduce(img, k = 4) {
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k), c = img.channels;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let ch = 0; ch < 3; ch++) {
    let s = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) s += img.data[((y * k + dy) * img.width + x * k + dx) * c + ch];
    out[(y * w + x) * 3 + ch] = Math.round(s / (k * k));
  }
  return { width: w, height: h, data: out };
}

export function psnr(a, b) {
  if (a.length !== b.length) return 0;
  let se = 0;
  for (let i = 0; i < a.length; i++) se += (a[i] - b[i]) ** 2;
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / a.length));
}

/** Fill the form and press the primary button; wait for the picture. */
async function create(page, { prompt = PROMPT, seed = '42', aspect = '1:1', steps = '2' } = {}) {
  await page.fill('textarea[data-input="prompt"]', prompt);
  await page.evaluate(() => { for (const d of document.querySelectorAll('main details.advanced')) d.open = true; }); // the expert settings are folded (a visual change only)
  await page.fill('input[data-input="seed"]', seed);
  // null: leave them (a picture to start from sets the shape and the steps)
  if (aspect) await page.check(`input[name="aspect"][value="${aspect}"]`, { force: true });
  if (steps) await page.check(`input[name="steps"][value="${steps}"]`, { force: true });
  const runs = await page.evaluate(() => globalThis.__elffuss.image.runs);
  const logs = [];
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text().slice(0, 300)); });
  await page.click('main button.primary');
  await page.waitForFunction(n => globalThis.__elffuss.image.runs > n || globalThis.__elffuss.errors.length > 0, runs, { timeout: 15 * 60 * 1000 });
  const d = await page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__elffuss)));
  if (d.errors.length) d.why = [await page.textContent('main p.status'), d.image.lastError, ...logs.slice(-4)];
  return d;
}

/** The picture on screen, as RGBA pixels (through a canvas: the page may not fetch its own blob: URLs). */
async function shown(page) {
  const r = await page.evaluate(async () => {
    const img = document.querySelector('section.result img');
    await img.decode();
    const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return { width: c.width, height: c.height, data: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
  });
  return { width: r.width, height: r.height, channels: 4, data: Uint8Array.from(r.data) };
}

export default [
  {
    name: 'a description gives the reference picture for its seed, stage by stage, with its download and history',
    sites: ['image'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const label = await page.textContent('main button.primary');
      t.ok(/Descargar el modelo \(3,2 GB\) y crear la imagen/.test(label), `the first click names the download: ${label}`);
      const d = await create(page);
      t.equal(d.errors, [], `errors (${JSON.stringify(d.why || [])})`);
      t.equal(d.device, null, 'the page does not use the WASM retry runner');
      const r = d.image.result;
      t.equal([r?.width, r?.height, r?.seed, r?.steps, r?.device], [1024, 1024, 42, 2, 'webgpu'], 'the picture it reports');
      for (const s of ['encode', 'step 1/2', 'step 2/2', 'decode']) t.ok(d.image.stages.includes(s), `stage ${s} shown`);
      const small = reduce(await shown(page));
      if (process.env.ELFFUSS_AI_IMAGE_GOLDEN === 'write') {
        const blob = await encodePngSamples({ width: small.width, height: small.height, channels: 3, data: small.data });
        const buf = Buffer.from(await blob.arrayBuffer());
        writeFileSync(GOLDEN, buf);
        t.note(`golden written, sha256 ${createHash('sha256').update(buf).digest('hex')}`);
      }
      const golden = await decodePng(readFileSync(GOLDEN));
      const p = psnr(small.data, golden.data);
      t.ok(p >= MIN_PSNR, `PSNR against the golden ${p.toFixed(2)} dB, at least ${MIN_PSNR}`);
      t.note(`PSNR ${p.toFixed(2)} dB`);
      t.equal(await page.textContent('[data-role="result-meta"]'), '1024 × 1024 px · semilla 42 · 2 pasos', 'the result line');
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('button[data-action="download"]')]);
      t.equal(download.suggestedFilename(), 'a-tiny-astronaut-hatching-from-an-egg-on-42.png', 'download name');
      await page.waitForSelector('[data-role="history-list"] li');
      t.equal(await page.locator('[data-role="history-list"] li').count(), 1, 'one history entry');
      // Another variation: a new seed, another picture, nothing downloaded again.
      const before = t.hubTotal();
      const runs = d.image.runs;
      await page.click('button[data-action="variation"]');
      await page.waitForFunction(n => globalThis.__elffuss.image.runs > n || globalThis.__elffuss.errors.length > 0, runs, { timeout: 10 * 60 * 1000 });
      const v = await page.evaluate(() => globalThis.__elffuss.image.result);
      t.ok(v.seed !== 42, `a new seed (${v.seed})`);
      t.ok(psnr(reduce(await shown(page)).data, golden.data) < 25, 'another picture');
      t.equal(t.hubTotal(), before, 'nothing downloaded for the second picture');
      t.equal(await page.locator('[data-role="history-list"] li').count(), 2, 'two history entries');
      t.equal(await page.evaluate(() => [...document.querySelectorAll('[style]')].map(e => e.tagName + '.' + e.className + ' ' + e.getAttribute('style')).slice(0, 4)), [], 'no inline styles');
      // ELFFUSS_AI_SHOTS=<dir>: screenshots of the page, to look at (nothing is compared).
      if (process.env.ELFFUSS_AI_SHOTS) {
        await page.screenshot({ path: join(process.env.ELFFUSS_AI_SHOTS, 'image-desktop.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: join(process.env.ELFFUSS_AI_SHOTS, 'image-phone.png'), fullPage: true });
        await page.setViewportSize({ width: 1100, height: 900 });
      }
      t.noPageErrors();
      await t.noCsp(page);
      t.networkClean(site);
    },
  },
  {
    name: 'a wide shape and four steps give a picture of that shape',
    sites: ['image'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/en/');
      const d = await create(page, { prompt: 'a rainy neon street at night, reflections on the wet asphalt', seed: '11', aspect: '16:9', steps: '4' });
      t.equal(d.errors, [], 'errors');
      t.equal([d.image.result?.width, d.image.result?.height, d.image.result?.steps], [1344, 768, 4], 'size and steps');
      t.ok(d.image.stages.includes('step 4/4'), 'four steps shown');
      const img = await shown(page);
      t.equal([img.width, img.height], [1344, 768], 'the PNG has that size');
      t.noPageErrors();
      await t.noCsp(page);
    },
  },
  {
    name: 'from a picture: a photo dropped in keeps its shape and becomes a new picture of it',
    sites: ['image'],
    configs: ['A'],
    async run(t, site) {
      // Until the model's published variant has the image encoder, the page does not offer it.
      if (!canStartFromImage(t.registry.models['text-to-image/sana-sprint-0.6b'])) { t.note('the published model has no image encoder yet: nothing to test'); return; }
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await page.waitForSelector('[data-role="from-image"]:not([hidden])');
      // a CC0 photo of the depth site (4:3 or so): the result keeps its shape
      await page.setInputFiles('input[data-input="image"]', join(ROOT, 'tests', 'fixtures', 'depth', 'foto.jpg'));
      await page.waitForSelector('[data-role="image-chosen"]:not([hidden])');
      t.ok(await page.isDisabled('input[name="aspect"][value="16:9"]'), 'the shape comes from the photo');
      const src = await page.evaluate(() => globalThis.__elffuss.image.source);
      t.equal(await page.inputValue('input[data-input="strength"]'), '70', 'the default strength');
      const d = await create(page, { prompt: 'en acuarela', seed: '5', aspect: null, steps: null }).catch(err => ({ errors: [String(err)] }));
      t.equal(d.errors, [], `errors (${JSON.stringify(d.why || [])})`);
      const r = d.image.result;
      t.equal([r?.fromImage, r?.strength, r?.steps], [true, 0.7, 2], 'made from the picture, at the strength asked');
      t.ok((d.image.caption || '').length > 20, `the picture was described first (${(d.image.caption || '').slice(0, 60)}…)`);
      const used = await page.textContent('[data-role="used-prompt"]');
      t.ok(used.includes('watercolor') && used.length > 40, `the prompt used leads with the caption and says the change: ${used.slice(0, 90)}…`);
      await page.click('button[data-action="edit-prompt"]');
      t.ok((await page.inputValue('textarea[data-input="prompt"]')).length > 40, 'Edit puts the prompt used in the box');
      t.ok(Math.abs(r.width / r.height - src.width / src.height) < 0.03, `the photo's shape (${r.width} × ${r.height} from ${src.width} × ${src.height})`);
      t.ok(d.image.stages.includes('encode-image'), 'the picture is read first');
      t.ok((await page.textContent('[data-role="from-image-meta"]')).includes('70'), 'the result says it came from the picture');
      t.equal(await page.evaluate(() => document.querySelectorAll('[style]').length), 0, 'no inline styles');
      // Removing the picture gives the shapes back.
      await page.click('button[data-action="remove-image"]');
      t.ok(!(await page.isDisabled('input[name="aspect"][value="16:9"]')), 'the shapes are back');
      t.noPageErrors();
      await t.noCsp(page);
      t.networkClean(site);
    },
  },
  {
    name: 'without WebGPU the page says so before anything is downloaded and the button stays off',
    sites: ['image'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      await page.waitForSelector('[data-role="unsupported"]:not([hidden])');
      t.ok((await page.textContent('[data-role="unsupported"]')).includes('WebGPU'), 'it names WebGPU');
      await page.fill('textarea[data-input="prompt"]', PROMPT);
      t.ok(await page.isDisabled('main button.primary'), 'the button stays off');
      t.equal(t.hub.counts.full.length, 0, 'nothing downloaded');
      t.noPageErrors();
      await t.noCsp(page);
    },
  },
];
