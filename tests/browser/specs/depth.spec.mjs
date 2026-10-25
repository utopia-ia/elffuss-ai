// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The depth site through its real page (photo in, primary button, result), in
// both configurations, validating the output and not only that it loads:
//  - the 16-bit download against tests/fixtures/depth/golden-depth.png (made with
//    WASM fp32): Pearson correlation of at least MIN_PEARSON for the variant used;
//  - the regions marked by hand in regiones.json: near beats far by MIN_NEAR_FAR
//    or more, and the middle sits between them;
//  - the grey download: 8-bit grey at the photo's size, the same map;
//  - the colour download: its farthest and nearest pixels are the first and last
//    colours of the ramp, read from the CSS variables (also when the shared look
//    redefines them);
//  - the 3D view: paints the photo with the page showing around it, turns with a
//    drag and with the keys, and comes back with its button;
//  - the button's label before and after, the backend the page reports, the
//    one retry on WASM after a WebGPU failure, cancel, and inputs that are not
//    photos.
//
// ELFFUSS_AI_DEPTH_GOLDEN=write (configuration B, the test "WASM fp32 …")
// writes golden-depth.png again from WASM fp32 and prints its sha256 for
// tests/fixtures/SOURCES.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodePng } from '../../../sdk/depth/png.js';
import { chooseVariant } from '../../../sdk/core/device.js';
import { variantFiles } from '../../../sdk/core/registry.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatMB } from '../../../scripts/lib/pages.mjs';
import { expectedDevice } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures', 'depth');
const PHOTO = join(FIX, 'foto.jpg');
const GOLDEN = join(FIX, 'golden-depth.png');
const REGIONS = JSON.parse(readFileSync(join(FIX, 'regiones.json'), 'utf8'));
const MODEL = 'depth/depth-anything-v2-small';
const RAMP_VARS = ['--line', '--accent2', '--accent', '--fg'];

/**
 * Least Pearson correlation with the reference, by the variant that ran. The
 * contract starts at 0.98 for WebGPU and 0.97 for WASM q8, and the final
 * values come from what was measured, with a margin: WASM q8 gave 0.99977 in
 * Chrome and in the bundled Chromium, so its floor is 0.995. WASM fp32 is the
 * reference itself and gives it back exactly. WebGPU keeps the starting value
 * until a run with a real adapter measures it.
 */
export const MIN_PEARSON = Object.freeze({ 'webgpu fp16': 0.98, 'webgpu fp32': 0.98, 'wasm q8': 0.995, 'wasm fp32': 0.999 });
/**
 * Least difference between the mean depth (0-1) of the near region and of the
 * far one. The contract asks for 0.1; WASM q8 and fp32 give 0.887, so 0.5.
 */
export const MIN_NEAR_FAR = 0.5;

/** Pearson correlation of two series of the same length. */
export function pearson(a, b) {
  if (a.length !== b.length || !a.length) throw new RangeError('the series differ in length');
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / a.length, mb = sb / b.length;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

/** Mean of the values of a map inside a rectangle `{ x, y, w, h }`. */
export function regionMean(values, width, { x, y, w, h }) {
  let s = 0;
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) s += values[j * width + i];
  return s / (w * h);
}

/** Depth values 0-1 of a 16-bit grey PNG. */
export async function depthOfPng16(bytes) {
  const p = await decodePng(bytes);
  if (p.bitDepth !== 16 || p.channels !== 1) throw new TypeError(`not a 16-bit grey PNG (${p.bitDepth} bits, ${p.channels} channels)`);
  return { width: p.width, height: p.height, values: Float64Array.from(p.data, v => v / 65535) };
}

/** `[r, g, b]` of a `#rrggbb` value, or null. */
export function hexColor(s) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(s).trim());
  return m ? m.slice(1).map(h => parseInt(h, 16)) : null;
}

const sha256 = b => createHash('sha256').update(b).digest('hex');
const variantUrls = (model, variant) => variantFiles(model, variant).map(f => f.url).sort();
const label = choice => `${choice.device} ${choice.dtype}`;

/** Change the registry the page reads (same origin), e.g. to pick another variant. */
async function withRegistry(ctx, change) {
  await ctx.route(/\/v\/[^/]+\/registry\/tasks\.json$/, async route => {
    const reg = await (await route.fetch()).json();
    change(reg.models[MODEL]);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reg) });
  });
}

/** What the page shows and what its test hooks recorded. */
function state(page) {
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const d = globalThis.__elffuss || {};
    const primary = q('main button.primary');
    return {
      probe: JSON.parse(JSON.stringify(d.depth || {})),
      device: d.device ?? null, fallback: d.fallback ?? null, errors: [...(d.errors || [])],
      status: q('main p.status')?.textContent ?? '',
      primary: { text: primary?.textContent ?? null, disabled: primary?.disabled ?? null },
      cancelHidden: q('main button[data-action="cancel"]')?.hidden ?? null,
      previewHidden: q('main figure[data-role="preview"]')?.hidden ?? null,
      caption: q('main [data-role="preview-caption"]')?.textContent ?? '',
      resultHidden: q('main section.result')?.hidden ?? null,
      meta: q('main [data-role="result-meta"]')?.textContent ?? null,
      fallbackText: q('main [data-role="fallback"]')?.textContent ?? null,
      cards: [...document.querySelectorAll('main section.result article.card')].map(c => c.dataset.role),
      styleAttrs: document.querySelectorAll('[style]').length,
      buttons: [...document.querySelectorAll('button')].map(b => b.className),
    };
  });
}

/** Choose a photo through the drop zone's input and wait until it is shown and the button enabled. */
async function pick(page, file = PHOTO) {
  await page.setInputFiles('main label.drop input[type="file"]', file);
  await page.waitForFunction(() => {
    const img = document.querySelector('main figure[data-role="preview"] img');
    return Boolean(img?.complete && img.naturalWidth > 0 && !document.querySelector('main button.primary').disabled);
  }, null, { timeout: 30000 });
}

/** Choose a file the page must refuse, and wait for the error it shows. */
async function pickRefused(page, file) {
  const before = await page.evaluate(() => globalThis.__elffuss.errors.length);
  await page.setInputFiles('main label.drop input[type="file"]', file);
  await page.waitForFunction(n => globalThis.__elffuss.errors.length > n, before, { timeout: 30000 });
}

/** Press the primary button and wait until the page is done with it. */
async function press(page, timeout = 900000) {
  await page.click('main button.primary');
  await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout, polling: 250 });
  return state(page);
}

/** Click a download button of the result and read the file it saves. */
async function download(page, action) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click(`main section.result button[data-action="${action}"]`),
  ]);
  return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
}

/** The colours of the ramp as the page computes its variables. */
async function pageRamp(page) {
  const values = await page.evaluate(vars => vars.map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim()), RAMP_VARS);
  return values.map(hexColor);
}

/** The 16-bit and grey downloads against the reference and the regions. */
async function checkMap(t, page, { min, what, name = 'foto' }) {
  const golden = await depthOfPng16(readFileSync(GOLDEN));
  const sixteen = await download(page, 'download-16');
  t.equal(sixteen.name, `${name}-profundidad-16bits.png`, `${what}: 16-bit file name`);
  const d = await depthOfPng16(sixteen.bytes);
  t.equal([d.width, d.height], [golden.width, golden.height], `${what}: the 16-bit map has the photo's size`);
  if (d.width !== golden.width || d.height !== golden.height) return null;
  const r = pearson(d.values, golden.values);
  t.ok(r >= min, `${what}: Pearson with the reference ${r.toFixed(5)}, want ≥ ${min}`);
  const m = Object.fromEntries(Object.entries(REGIONS.regions).map(([k, rect]) => [k, regionMean(d.values, d.width, rect)]));
  t.ok(m.cerca - m.lejos >= MIN_NEAR_FAR, `${what}: near ${m.cerca.toFixed(3)} beats far ${m.lejos.toFixed(3)} by ≥ ${MIN_NEAR_FAR}`);
  t.ok(m.cerca > m.medio && m.medio > m.lejos, `${what}: near ${m.cerca.toFixed(3)} > middle ${m.medio.toFixed(3)} > far ${m.lejos.toFixed(3)}`);
  const grey = await download(page, 'download-grey');
  t.equal(grey.name, `${name}-profundidad.png`, `${what}: grey file name`);
  const g = await decodePng(grey.bytes);
  t.equal([g.width, g.height, g.bitDepth], [d.width, d.height, 8], `${what}: grey PNG at the photo's size, 8 bits`);
  const gv = new Float64Array(g.width * g.height);
  let notGrey = 0;
  for (let i = 0; i < gv.length; i++) {
    const o = i * g.channels;
    if (g.channels >= 3 && (g.data[o] !== g.data[o + 1] || g.data[o] !== g.data[o + 2])) notGrey++;
    gv[i] = g.data[o] / 255;
  }
  t.equal(notGrey, 0, `${what}: the grey PNG is grey`);
  t.ok(pearson(gv, d.values) > 0.999, `${what}: the grey and 16-bit maps are the same map`);
  return { r, means: m, values: d.values, width: d.width };
}

/** The colour download: farthest and nearest pixels are the ends of the ramp. */
async function checkColours(t, page, map, stops, name = 'foto') {
  const colour = await download(page, 'download-color');
  t.equal(colour.name, `${name}-profundidad-color.png`, 'colour file name');
  const c = await decodePng(colour.bytes);
  let near = 0, far = 0;
  for (let i = 1; i < map.values.length; i++) { if (map.values[i] > map.values[near]) near = i; if (map.values[i] < map.values[far]) far = i; }
  const at = i => [...c.data.subarray(i * c.channels, i * c.channels + 3)];
  const close = (a, b) => a && b && a.every((v, k) => Math.abs(v - b[k]) <= 1);
  t.ok(stops.every(Boolean), `the ramp variables are colours (${JSON.stringify(stops)})`);
  t.ok(close(at(near), stops.at(-1)), `the nearest pixel is ${RAMP_VARS.at(-1)}: ${at(near)} vs ${stops.at(-1)}`);
  t.ok(close(at(far), stops[0]), `the farthest pixel is ${RAMP_VARS[0]}: ${at(far)} vs ${stops[0]}`);
}

/** The 3D view: covers part of the canvas, turns, and comes back. */
async function check3d(t, page) {
  const frames = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const look = () => page.evaluate(() => {
    const c = document.querySelector('main article[data-role="view3d"] canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let hash = 2166136261, opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3]) opaque++;
      hash = Math.imul(hash ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)), 16777619) >>> 0;
    }
    return { w: c.width, h: c.height, opaque, hash, view: globalThis.__elffuss?.depth?.view ?? null };
  });
  await frames();
  const first = await look();
  const share = first.opaque / (first.w * first.h);
  t.ok(share > 0.3 && share < 1, `3D: the photo covers ${Math.round(share * 100)}% of the view, with the page around it`);
  const canvas = page.locator('main article[data-role="view3d"] canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await frames();
  const dragged = await look();
  t.ok(dragged.view.yaw > first.view.yaw && dragged.view.pitch > first.view.pitch, `3D: a drag right and down turns it (${JSON.stringify(dragged.view)})`);
  t.ok(dragged.hash !== first.hash, '3D: and repaints it');
  await canvas.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await frames();
  const keyed = await look();
  t.ok(keyed.view.yaw < dragged.view.yaw - 0.2, `3D: the arrow keys turn it (${dragged.view.yaw.toFixed(2)} → ${keyed.view.yaw.toFixed(2)})`);
  await page.click('main article[data-role="view3d"] button[data-action="reset-view"]');
  await frames();
  const back = await look();
  t.ok(back.w === first.w && back.h === first.h && back.hash === first.hash, '3D: its button brings back the first view, pixel for pixel');
  await page.evaluate(() => { const r = document.querySelector('main article[data-role="view3d"] input[type="range"]'); r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await frames();
  const flat = await look();
  t.ok(flat.view.relief === 0 && flat.hash !== back.hash, '3D: the relief control flattens it');
}

/** The checks of a page after a good run. */
async function checkRun(t, page, st, { device, choice, s, runs = 1, name = 'foto.jpg' }) {
  t.equal(st.probe.runs, runs, `${runs} result(s) (status "${st.status}", errors ${JSON.stringify(st.errors)})`);
  t.equal([st.probe.device, st.device, st.probe.dtype], [device, device, choice.dtype], 'backend and variant');
  t.equal(st.meta, `${s['device.' + device]} · 960 × 638 px`, 'the page says the backend and the size');
  t.equal(st.status, s['status.done'], 'status');
  // The label is refreshed from the store right after the button is enabled again.
  const label = await page.waitForFunction(text => {
    const b = document.querySelector('main button.primary');
    return b.textContent === text && !b.disabled ? b.textContent : false;
  }, s['action.run'], { timeout: 15000 }).then(h => h.jsonValue(), () => page.evaluate(() => document.querySelector('main button.primary').textContent));
  t.equal(label, s['action.run'], 'after the run the model is stored and the label says so');
  t.equal(st.cancelHidden, true, 'cancel hidden again');
  t.equal(st.cards, ['map', 'view3d'], 'the map and the 3D view');
  t.equal(st.styleAttrs, 0, 'no style attribute after a run');
  t.ok(st.buttons.filter(c => c === 'primary').length === 1 && st.buttons.every(c => c === 'primary' || c === 'ghost'), `one button.primary, the rest .ghost (${st.buttons})`);
  t.equal(st.caption, `${name} · 960 × 638 px`, 'the chosen photo with its size');
}

export default [
  {
    name: 'a photo gives a depth map that matches the reference, with its downloads and the 3D view',
    sites: ['depth'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const model = t.registry.models[MODEL];
      const device = expectedDevice(site, t.registry, t.config);
      const choice = chooseVariant(model, 'auto', t.probe);
      const s = t.strings.depth.es;
      const before = await state(page);
      t.equal(before.primary, { text: fill(s['action.downloadAndRun'], { size: `${formatMB(choice.variant.bytes, 'es')} MB` }), disabled: true }, 'before a photo: disabled, and it says what it will download');
      await pick(page);
      t.equal((await state(page)).primary.disabled, false, 'a photo enables it');
      t.equal(t.hubTotal(), 0, 'nothing is downloaded before the button');
      const st = await press(page);
      await checkRun(t, page, st, { device, choice, s });
      t.equal(st.fallback, null, 'no fallback');
      t.equal(t.hubFull(), variantUrls(model, choice.variant), 'downloaded the files of the variant, once each');
      const map = await checkMap(t, page, { min: MIN_PEARSON[label(choice)], what: label(choice) });
      if (map) await checkColours(t, page, map, await pageRamp(page));
      await check3d(t, page);
      // A second run of the same photo: from memory, nothing downloaded.
      t.hub.reset();
      const again = await press(page);
      t.equal(again.probe.runs, 2, 'a second run');
      t.equal(t.hubTotal(), 0, 'without any download');
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
      if (map) t.note(`${label(choice)}: Pearson ${map.r.toFixed(5)}; near ${map.means.cerca.toFixed(3)}, middle ${map.means.medio.toFixed(3)}, far ${map.means.lejos.toFixed(3)}`);
    },
  },
  {
    name: 'WebGPU fp32, the variant for adapters without shader-f16, matches the reference too',
    sites: ['depth'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      await withRegistry(ctx, m => { m.devices.webgpu = m.devices.webgpu.filter(v => v.dtype === 'fp32'); });
      const page = await t.open(ctx, site, '/');
      const model = t.registry.models[MODEL];
      const choice = { device: 'webgpu', dtype: 'fp32', variant: model.devices.webgpu.find(v => v.dtype === 'fp32') };
      await pick(page);
      const st = await press(page);
      await checkRun(t, page, st, { device: 'webgpu', choice, s: t.strings.depth.es });
      t.equal(t.hubFull(), variantUrls(model, choice.variant), 'downloaded the fp32 files');
      const map = await checkMap(t, page, { min: MIN_PEARSON['webgpu fp32'], what: 'webgpu fp32' });
      await t.noCsp(page);
      t.noPageErrors();
      if (map) t.note(`webgpu fp32: Pearson ${map.r.toFixed(5)}`);
    },
  },
  {
    name: '?device=wasm runs WASM q8 even where WebGPU is available, and matches the reference',
    sites: ['depth'],
    configs: ['A'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/?device=wasm');
      const model = t.registry.models[MODEL];
      const choice = chooseVariant(model, 'wasm', t.probe);
      await pick(page);
      const st = await press(page);
      await checkRun(t, page, st, { device: 'wasm', choice, s: t.strings.depth.es });
      const map = await checkMap(t, page, { min: MIN_PEARSON['wasm q8'], what: 'wasm q8 (asked)' });
      t.noPageErrors();
      if (map) t.note(`wasm q8 with WebGPU present: Pearson ${map.r.toFixed(5)}`);
    },
  },
  {
    name: 'WASM fp32 gives the reference back (ELFFUSS_AI_DEPTH_GOLDEN=write makes it)',
    sites: ['depth'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      await withRegistry(ctx, m => { m.devices.wasm = m.devices.webgpu.filter(v => v.dtype === 'fp32').map(v => ({ ...v, when: undefined })); });
      const page = await t.open(ctx, site, '/');
      const model = t.registry.models[MODEL];
      const choice = { device: 'wasm', dtype: 'fp32', variant: model.devices.webgpu.find(v => v.dtype === 'fp32') };
      await pick(page);
      const st = await press(page);
      await checkRun(t, page, st, { device: 'wasm', choice, s: t.strings.depth.es });
      if (process.env.ELFFUSS_AI_DEPTH_GOLDEN === 'write') {
        const sixteen = await download(page, 'download-16');
        writeFileSync(GOLDEN, sixteen.bytes);
        t.note(`wrote tests/fixtures/depth/golden-depth.png (${sixteen.bytes.length} bytes, sha256 ${sha256(sixteen.bytes)})`);
        return;
      }
      const map = await checkMap(t, page, { min: MIN_PEARSON['wasm fp32'], what: 'wasm fp32' });
      t.noPageErrors();
      if (map) t.note(`wasm fp32: Pearson ${map.r.toFixed(6)}`);
    },
  },
  {
    name: 'a failure inside the runtime: on WebGPU the page retries once on WASM and says so; on WASM the next click works',
    sites: ['depth'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/?test-fail=run');
      const model = t.registry.models[MODEL];
      const s = t.strings.depth.es;
      await pick(page);
      const st = await press(page);
      const wasm = chooseVariant(model, 'wasm', t.probe);
      if (t.config === 'A') {
        await checkRun(t, page, st, { device: 'wasm', choice: wasm, s });
        t.equal(st.fallback, { from: 'webgpu', reason: 'run-failed' }, 'the retry is reported');
        t.equal(st.fallbackText, s['fallback.wasm'], 'and the page says it');
        const gpu = chooseVariant(model, 'auto', t.probe);
        t.equal(t.hubFull(), [...new Set([...variantUrls(model, gpu.variant), ...variantUrls(model, wasm.variant)])].sort(), 'both variants were downloaded, once each');
        await checkMap(t, page, { min: MIN_PEARSON['wasm q8'], what: 'wasm q8 after the retry' });
      } else {
        t.equal(st.status, s['error.run-failed'], 'on WASM there is no second backend: the error shows');
        t.equal([st.probe.runs, st.resultHidden], [0, true], 'and no result');
        const again = await press(page);
        await checkRun(t, page, again, { device: 'wasm', choice: wasm, s });
        t.equal(again.fallback, null, 'no fallback on WASM');
        t.equal(t.hub.counts.full.length, t.hubFull().length, 'the new Worker read the model from the store, not the Hub');
      }
      t.noPageErrors();
    },
  },
  {
    name: 'the map takes its colours from the CSS variables, also when the shared look redefines them; paste works',
    sites: ['depth'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const look = ':root { --line: #10203a; --accent2: #40a050; --accent: #c08010; --fg: #e0f0fe; }\n';
      await ctx.route(/\/v\/[^/]+\/shared\/elffuss-look\.css$/, route => route.fulfill({ status: 200, contentType: 'text/css', body: look }));
      const page = await t.open(ctx, site, '/');
      const stops = await pageRamp(page);
      t.equal(stops, [[0x10, 0x20, 0x3a], [0x40, 0xa0, 0x50], [0xc0, 0x80, 0x10], [0xe0, 0xf0, 0xfe]], 'the page computes the redefined variables');
      const b64 = readFileSync(PHOTO).toString('base64');
      await page.evaluate(async data => {
        const bytes = Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'portapapeles.jpg', { type: 'image/jpeg' }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, b64);
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 30000 });
      const st = await press(page);
      const s = t.strings.depth.es;
      await checkRun(t, page, st, { device: 'wasm', choice: chooseVariant(t.registry.models[MODEL], 'auto', t.probe), s, name: 'pegado-1.jpg' });
      const map = await checkMap(t, page, { min: MIN_PEARSON['wasm q8'], what: 'pasted photo', name: 'pegado-1' });
      if (map) await checkColours(t, page, map, stops, 'pegado-1');
      await t.noCsp(page);
      t.noPageErrors();
    },
  },
  {
    name: 'files that are not photos: the page says why and enables nothing; a broken image fails on its own',
    sites: ['depth'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const s = t.strings.depth.es;
      const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(40)]);
      const cases = [
        [{ name: 'escaneo.heic', mimeType: 'image/heic', buffer: heic }, 'error.unsupported-format'],
        [{ name: 'nota.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('esto no es una foto\n') }, 'error.unsupported-format'],
        [{ name: 'vacia.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }, 'error.decode-failed'],
      ];
      for (const [file, key] of cases) {
        await pickRefused(page, file);
        const st = await state(page);
        t.equal([st.status, st.primary.disabled, st.previewHidden], [s[key], true, true], `${file.name}: ${key}, nothing enabled, no preview`);
      }
      t.equal(t.hubTotal(), 0, 'nothing downloaded for files the page refused');
      // A PNG whose header is right and whose data is not: the page lets it through, the Worker cannot decode it.
      const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('basura que no es una imagen')]);
      await page.setInputFiles('main label.drop input[type="file"]', { name: 'rota.png', mimeType: 'image/png', buffer: broken });
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 30000 });
      const st = await press(page);
      t.equal([st.status, st.probe.runs ?? 0, st.resultHidden], [s['error.decode-failed'], 0, true], 'a broken image says it cannot be opened');
      await pick(page);
      const good = await press(page);
      t.equal([good.probe.runs, good.status], [1, s['status.done']], 'and the next photo works');
      t.noPageErrors();
    },
  },
  {
    name: 'a photo larger than 2048 px is scaled down first, the page says so, and the map keeps near and far',
    sites: ['depth'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const s = t.strings.depth.es;
      // The fixture drawn at 3000 × 1994 px in the page, chosen through the drop zone's input.
      await page.evaluate(async data => {
        const bytes = Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const canvas = new OffscreenCanvas(3000, 1994);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, 3000, 1994);
        const dt = new DataTransfer();
        dt.items.add(new File([await canvas.convertToBlob({ type: 'image/png' })], 'grande.png', { type: 'image/png' }));
        const input = document.querySelector('main label.drop input[type="file"]');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, readFileSync(PHOTO).toString('base64'));
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
      const st = await press(page);
      t.equal([st.probe.runs, st.probe.scaled, st.probe.width, st.probe.height], [1, true, 2048, 1361], 'computed at 2048 px on the long side');
      t.equal(st.meta, `${s['device.wasm']} · 2048 × 1361 px`, 'the page says the size it used');
      const scaled = await page.evaluate(() => document.querySelector('main [data-role="scaled"]')?.textContent ?? null);
      t.equal(scaled, fill(s['result.scaled'], { sourceWidth: 3000, sourceHeight: 1994, width: 2048, height: 1361 }), 'and that it scaled the photo down');
      const d = await depthOfPng16((await download(page, 'download-16')).bytes);
      t.equal([d.width, d.height], [2048, 1361], 'the 16-bit map has the size used');
      const k = [2048 / REGIONS.width, 1361 / REGIONS.height];
      const at = r => ({ x: Math.round(r.x * k[0]), y: Math.round(r.y * k[1]), w: Math.round(r.w * k[0]), h: Math.round(r.h * k[1]) });
      const m = Object.fromEntries(Object.entries(REGIONS.regions).map(([name, r]) => [name, regionMean(d.values, d.width, at(r))]));
      t.ok(m.cerca - m.lejos >= MIN_NEAR_FAR && m.cerca > m.medio && m.medio > m.lejos, `near ${m.cerca.toFixed(3)} > middle ${m.medio.toFixed(3)} > far ${m.lejos.toFixed(3)}`);
      t.equal((await state(page)).cards, ['map', 'view3d'], 'the map and the 3D view');
      t.noPageErrors();
    },
  },
  {
    name: 'cancel while it runs: the page says so, shows nothing, and the next click works without downloading again',
    sites: ['depth'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/');
      const s = t.strings.depth.es;
      await pick(page);
      await page.click('main button.primary');
      t.equal(await page.isVisible('main button[data-action="cancel"]'), true, 'cancel shows while busy');
      await page.waitForFunction(text => document.querySelector('main p.status').textContent === text, s['status.running'], { timeout: 600000, polling: 50 });
      await page.click('main button[data-action="cancel"]');
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
      const st = await state(page);
      t.equal([st.status, st.probe.runs, st.resultHidden, st.cancelHidden], [s['error.aborted'], 0, true, true], 'cancelled, no result, cancel hidden');
      t.hub.reset();
      const again = await press(page);
      t.equal([again.probe.runs, again.status], [1, s['status.done']], 'the next click works');
      t.equal(t.hubTotal(), 0, 'from the store');
      t.noPageErrors();
    },
  },
  {
    name: '?device=webgpu without WebGPU says so, before and after the click, and downloads nothing',
    sites: ['depth'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/?device=webgpu');
      const s = t.strings.depth.es;
      t.equal((await state(page)).status, s['error.webgpu-unavailable'], 'at load');
      await pick(page);
      const st = await press(page);
      t.equal([st.status, st.probe.runs], [s['error.webgpu-unavailable'], 0], 'after the click');
      t.equal(t.hubTotal(), 0, 'nothing downloaded');
      t.noPageErrors();
    },
  },
];
