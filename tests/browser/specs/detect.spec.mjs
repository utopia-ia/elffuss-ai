// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// detect.elffuss.com through its real page, in both configurations, with the
// output checked against boxes drawn by hand on a CC0 photo
// (tests/fixtures/detect/foto.jpg and cajas.json): every hand box needs a
// detection of its class with IoU ≥ 0.5 and score ≥ 0.5, and no detection of
// 0.7 or more may be left without a hand box. The same holds for three
// consecutive frames of Chrome's fake camera fed with the same photo (a .y4m the
// spec writes into the cache, never committed); Stop leaves the tracks ended;
// only this site may open the camera, and a refused camera is explained. The
// confidence slider filters without running the model again; the JSON and PNG
// downloads hold what the page shows; a failure inside the runtime is followed
// by a working run.
//
// It also keeps the decoder's reference outputs honest: the raw outputs of the
// model for the photo, saved in tests/fixtures/detect/golden-outputs-wasm.json
// for the unit test of the decoder, must still be what the model gives. With
// ELFFUSS_AI_UPDATE_DETECT_OUTPUTS=1 that test writes the file instead.
//
// The camera tests need Chrome flags the shared harness does not pass, so this
// spec opens those browser profiles itself, the same way the harness does.
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chooseVariant } from '../../../sdk/core/device.js';
import { variantFiles } from '../../../sdk/core/registry.js';
import { CONFIGS, expectedDevice } from '../harness.mjs';
import { cameraErrorKey } from '../../../apps/detect/camera.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatMB } from '../../../scripts/lib/pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIX = join(ROOT, 'tests', 'fixtures', 'detect');
export const PHOTO = join(FIX, 'foto.jpg');
export const GOLDEN = join(FIX, 'golden-outputs-wasm.json');
const HAND = JSON.parse(readFileSync(join(FIX, 'cajas.json'), 'utf8'));
/** Rows of the raw outputs kept in the reference file: the queries with the highest scores. */
export const GOLDEN_ROWS = 40;

// ── pure helpers (unit-tested in tests/unit/detect-spec.test.mjs) ─────────────

/** Intersection over union of two boxes { xmin, ymin, xmax, ymax }. */
export function iou(a, b) {
  const w = Math.min(a.xmax, b.xmax) - Math.max(a.xmin, b.xmin);
  const h = Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin);
  if (!(w > 0 && h > 0)) return 0;
  const inter = w * h;
  const area = x => Math.max(0, x.xmax - x.xmin) * Math.max(0, x.ymax - x.ymin);
  return inter / (area(a) + area(b) - inter);
}

/**
 * Compare detections with hand boxes. Each hand box takes the detection of its
 * class with the highest IoU among those with score ≥ minScore not taken yet;
 * it is met when that IoU is ≥ minIou. A detection of extraScore or more that
 * no hand box took is an extra.
 * @param {{ label: string, score: number, box: object }[]} objects
 * @param {{ label: string, box: object }[]} hand
 */
export function matchToHand(objects, hand, { minIou = 0.5, minScore = 0.5, extraScore = 0.7 } = {}) {
  const taken = new Set();
  const pairs = [], misses = [];
  for (const h of hand) {
    let best = -1, bestIou = 0;
    objects.forEach((o, i) => {
      if (taken.has(i) || o.label !== h.label || !(o.score >= minScore)) return;
      const v = iou(o.box, h.box);
      if (v > bestIou) { bestIou = v; best = i; }
    });
    if (best < 0 || bestIou < minIou) misses.push({ label: h.label, iou: bestIou });
    else { taken.add(best); pairs.push({ label: h.label, iou: bestIou, score: objects[best].score }); }
  }
  const extra = objects.filter((o, i) => !taken.has(i) && o.score >= extraScore).map(o => ({ label: o.label, score: o.score }));
  return { ok: misses.length === 0 && extra.length === 0, pairs, misses, extra };
}

/** One line about a match, for notes and failures. */
export function describeMatch(m) {
  const r2 = x => Math.round(x * 100) / 100;
  const parts = m.pairs.map(p => `${p.label} iou ${r2(p.iou)} score ${r2(p.score)}`);
  for (const x of m.misses) parts.push(`MISSING ${x.label} (best iou ${r2(x.iou)})`);
  for (const x of m.extra) parts.push(`EXTRA ${x.label} ${r2(x.score)}`);
  return parts.join('; ');
}

/** Hand boxes as fractions of the image (camera frames are compared this way). */
export function normalizedHand(hand) {
  return hand.boxes.map(b => ({ label: b.label, box: { xmin: b.box.xmin / hand.width, ymin: b.box.ymin / hand.height, xmax: b.box.xmax / hand.width, ymax: b.box.ymax / hand.height } }));
}

const clampByte = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * RGBA pixels to I420 (planar Y, then U and V at half size), BT.601 limited
 * range, the format Chrome's fake camera reads from a .y4m file. Width and
 * height must be even.
 */
export function rgbaToI420(rgba, width, height) {
  if (width % 2 || height % 2) throw new Error('width and height must be even');
  const cw = width / 2, ch = height / 2, ySize = width * height;
  const out = Buffer.alloc(ySize + 2 * cw * ch);
  for (let i = 0, p = 0; p < ySize; p++, i += 4) out[p] = clampByte(16 + 0.2568 * rgba[i] + 0.5041 * rgba[i + 1] + 0.0979 * rgba[i + 2]);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((2 * y + dy) * width + 2 * x + dx) * 4;
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
      }
      r /= 4; g /= 4; b /= 4;
      out[ySize + y * cw + x] = clampByte(128 - 0.1482 * r - 0.291 * g + 0.4392 * b);
      out[ySize + cw * ch + y * cw + x] = clampByte(128 + 0.4392 * r - 0.3678 * g - 0.0714 * b);
    }
  }
  return out;
}

/** A .y4m file that shows the same I420 picture for `frames` frames. */
export function y4m(width, height, i420, { frames = 3, fps = 10 } = {}) {
  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < frames; f++) parts.push(Buffer.from('FRAME\n'), i420);
  return Buffer.concat(parts);
}

/** The best `rows` queries of raw outputs, by their best named class. */
export function topRows({ logits, boxes, classes, queries, named, rows }) {
  const best = [];
  for (let q = 0; q < queries; q++) {
    let m = -Infinity;
    for (const k of named) m = Math.max(m, logits[q * classes + k]);
    best.push([m, q]);
  }
  best.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return best.slice(0, rows).map(([, q]) => ({
    query: q,
    logits: Array.from(logits.slice(q * classes, (q + 1) * classes), v => Math.round(v * 1e4) / 1e4),
    box: Array.from(boxes.slice(q * 4, q * 4 + 4), v => Math.round(v * 1e6) / 1e6),
  }));
}

// ── browser helpers ──────────────────────────────────────────────────────────

const sel = {
  input: 'main label.drop input[type="file"]',
  primary: 'main button.primary',
  camera: 'main [data-action="camera"]',
  stop: 'main [data-action="stop"]',
  slider: 'main [data-input="threshold"]',
  json: 'main [data-action="download-json"]',
  png: 'main [data-action="download-png"]',
};

/** What the page shows. */
function facts(page) {
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const box = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const overlay = q('[data-role="overlay"]');
    const image = q('[data-role="image"]');
    let painted = 0;
    if (overlay.width && overlay.height) {
      const d = overlay.getContext('2d').getImageData(0, 0, overlay.width, overlay.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) painted++;
    }
    return {
      status: q('main p.status').textContent,
      primary: q('main button.primary').textContent,
      primaryDisabled: q('main button.primary').disabled,
      summary: q('[data-role="summary"]').textContent,
      items: [...document.querySelectorAll('[data-role="objects"] li')].map(li => ({ label: li.dataset.label || null, text: li.textContent })),
      overlay: { width: overlay.width, height: overlay.height, ...box(overlay) },
      image: { hidden: image.hidden, natural: [image.naturalWidth, image.naturalHeight], ...box(image) },
      video: { hidden: q('[data-role="video"]').hidden },
      frame: { hidden: q('[data-role="frame"]').hidden },
      cameraHidden: q('main [data-action="camera"]').hidden,
      stopHidden: q('main [data-action="stop"]').hidden,
      resultHidden: q('main section.result').hidden,
      downloadsHidden: q('main [data-action="download-json"]').hidden,
      thresholdText: q('[data-role="threshold-value"]').textContent,
      styleAttrs: document.querySelectorAll('[style]').length,
      painted,
    };
  });
}

const hook = page => page.evaluate(() => {
  const d = globalThis.__elffuss?.detect;
  return d ? { runs: d.runs, last: d.last, frames: d.frames.slice(), tracks: d.tracks(), errors: globalThis.__elffuss.errors.slice() } : null;
});

/** Choose the photo, press the primary button and wait for the run to end. */
async function detectPhoto(page, photo = PHOTO) {
  const before = (await hook(page)).runs;
  await page.setInputFiles(sel.input, photo);
  await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 60000 });
  await page.click(sel.primary);
  await page.waitForFunction(n => {
    const e = globalThis.__elffuss;
    return (e.detect.runs > n || e.errors.length > 0) && !document.querySelector('main button.primary').disabled;
  }, before, { timeout: 600000 });
  return hook(page);
}

/** Open a page of the site and wait until the app has wired its controls (data-app="ready"). */
async function openApp(t, ctx, site, path) {
  const page = await t.open(ctx, site, path);
  await page.waitForFunction(() => document.documentElement.dataset.app === 'ready', null, { timeout: 60000 });
  return page;
}

/** Wait for the primary button to say `text` (the store is asked again after each action). */
async function primarySays(page, text) {
  await page.waitForFunction(x => document.querySelector('main button.primary').textContent === x, text, { timeout: 30000 }).catch(() => {});
}

async function setSlider(page, value) {
  await page.$eval(sel.slider, (input, v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); }, String(value));
}

/** The labels the page lists, in order. */
const listed = f => f.items.map(i => i.label).filter(Boolean);

/** Width and height of a PNG file, from its header. */
function pngSize(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

/**
 * A browser profile like the harness's (Hub mock, requests and page errors
 * recorded, removed at the end), with the camera flags Chrome needs.
 * @param {any} t the TestRun
 * @param {{ y4m?: string, deny?: boolean }} o
 */
async function cameraContext(t, { y4m: file, deny = false } = {}) {
  const tmp = join(t.cache, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, 'profile-'));
  const args = [...CONFIGS[t.config].args, '--use-fake-device-for-media-stream', deny ? '--deny-permission-prompts' : '--use-fake-ui-for-media-stream'];
  if (file) args.push(`--use-file-for-fake-video-capture=${file}`);
  const ctx = await t.playwright.chromium.launchPersistentContext(dir, {
    ...(t.browser === 'chrome' ? { channel: 'chrome' } : {}),
    headless: t.headless,
    args,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true,
    env: { ...process.env, TMPDIR: tmp },
    viewport: { width: 1100, height: 900 },
  });
  t.contexts.push({ ctx, dir });
  await ctx.route(t.hub.pattern, t.hub.handler);
  ctx.on('request', r => {
    let frame = null;
    try { frame = r.frame()?.url() ?? null; } catch { frame = null; }
    t.requests.push({ url: r.url(), method: r.method(), frame, type: r.resourceType(), body: Boolean(r.postDataBuffer()) });
  });
  const watch = p => p.on('pageerror', e => t.pageErrors.push({ page: p.url(), message: String(e.message || e).slice(0, 300) }));
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
  return ctx;
}

/** The fake camera's video: the photo, decoded by the browser, as a .y4m in the cache. */
async function cameraVideo(t, site) {
  const photo = readFileSync(PHOTO);
  const out = join(t.cache, 'tmp', `detect-camera-${createHash('sha256').update(photo).digest('hex').slice(0, 12)}.y4m`);
  if (existsSync(out)) return out;
  const ctx = await t.newContext();
  const page = await t.open(ctx, site, '/licencias/', { wait: 'load' });
  const img = await page.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    return { width: bmp.width, height: bmp.height, rgba: btoa(s) };
  }, photo.toString('base64'));
  writeFileSync(out, y4m(img.width, img.height, rgbaToI420(Buffer.from(img.rgba, 'base64'), img.width, img.height)));
  return out;
}

/** Raw outputs of the model for the photo, through the SDK in the page (WebAssembly). */
function captureOutputs(page) {
  return page.evaluate(async ({ b64, rows }) => {
    const base = new URL(document.querySelector('script[type="module"][src]').getAttribute('src'), location.href);
    const at = p => new URL(p, base).href;
    const [{ default: config }, { Task }, { createStoreClient }, impl, { decodeImage }, { labelList }] = await Promise.all([
      import(at('config.js')), import(at('sdk/core/task.js')), import(at('sdk/core/store-client.js')),
      import(at('sdk/detect/impl.js')), import(at('sdk/core/image-input.js')), import(at('sdk/detect/decode.js'))]);
    const probe = {
      task: 'detect',
      load: impl.load,
      dispose: impl.dispose,
      async run(state, input) {
        const img = await decodeImage(input, { maxSide: impl.DECODE_MAX_SIDE });
        const out = await impl.forward(state, img);
        const [, queries, classes] = out.logits.dims;
        const labels = labelList(state.id2label, classes);
        const named = labels.map((l, k) => (l ? k : -1)).filter(k => k >= 0);
        const value = { width: img.sourceWidth, height: img.sourceHeight, queries, classes, id2label: state.id2label, logits: Array.from(out.logits.data), boxes: Array.from(out.boxes.data), named, rows };
        return { value };
      },
    };
    const store = createStoreClient({ url: config.storeUrl });
    const task = new Task({ task: 'detect', workerUrl: null, impl: async () => probe }, { worker: false, device: 'wasm', model: config.model, store, runtime: config.runtime });
    try {
      const value = await task.run(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
      return { ...value, info: task.info };
    } finally {
      await task.dispose();
      store.dispose?.();
    }
  }, { b64: readFileSync(PHOTO).toString('base64'), rows: GOLDEN_ROWS });
}

const variantUrls = (t, site) => {
  const m = t.registry.models[site.models[0]];
  return variantFiles(m, chooseVariant(m, 'auto', t.probe).variant).map(f => f.url).sort();
};

/**
 * The labelled photos of the repository, each with the objects drawn by hand on
 * it (the cutout photo's box is the one around the outline traced by hand in
 * cutout/mascara.json), and one photo with no COCO object at all. A photo whose
 * fixture is not in this tree is left out.
 */
export function labelledSet(root = ROOT) {
  const set = [{ name: 'detect/foto.jpg', photo: PHOTO, boxes: HAND.boxes }];
  const cutout = join(root, 'tests', 'fixtures', 'cutout');
  if (existsSync(join(cutout, 'mascara.json'))) {
    const m = JSON.parse(readFileSync(join(cutout, 'mascara.json'), 'utf8'));
    const pts = m.polygons.flat();
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    set.push({ name: 'cutout/foto.jpg', photo: join(cutout, 'foto.jpg'), boxes: [{ label: 'dog', box: { xmin: Math.min(...xs), ymin: Math.min(...ys), xmax: Math.max(...xs), ymax: Math.max(...ys) } }] });
  }
  const depth = join(root, 'tests', 'fixtures', 'depth', 'foto.jpg');
  if (existsSync(depth)) set.push({ name: 'depth/foto.jpg', photo: depth, boxes: [] });
  return set;
}

/**
 * What the model must reach on the labelled set with its input normalised as it
 * was trained (ImageNet mean and deviation). In this page, fed x/255 only, as
 * its config says, the cat of detect/foto.jpg scored about 0.66 and a second,
 * duplicate cat about 0.38; normalised, about 0.78 and 0.27. The bounds sit
 * halfway, so either input is told apart with room on both sides.
 */
export const RECALL = Object.freeze({ minScore: 0.5, minIou: 0.5, catScore: 0.72, duplicate: 0.33 });

// ── tests ────────────────────────────────────────────────────────────────────

export default [
  {
    name: 'finds the hand-boxed objects of the photo; the slider filters without running again; downloads match',
    sites: ['detect'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await openApp(t, ctx, site, '/');
      const s = t.strings[site.site].es;
      const m = t.registry.models[site.models[0]];
      const choice = chooseVariant(m, 'auto', t.probe);
      let f = await facts(page);
      t.equal(f.primary, fill(s['action.downloadAndRun'], { size: `${formatMB(choice.variant.bytes, 'es')} MB` }), 'primary label on a fresh profile');
      t.equal(f.primaryDisabled, true, 'nothing to detect yet: the primary button waits for an image');
      t.equal(f.thresholdText, '0,50', 'slider value as the page writes it');
      const r = await detectPhoto(page);
      if (!t.ok(r.last, `no result: ${JSON.stringify(r.errors)}`)) return;
      t.equal(r.last.device, expectedDevice(site, t.registry, t.config), 'backend');
      t.equal([r.last.width, r.last.height], [HAND.width, HAND.height], 'boxes in pixels of the photo');
      const match = matchToHand(r.last.objects, HAND.boxes);
      t.ok(match.ok, `photo against the hand boxes: ${describeMatch(match)}`);
      t.note(`${r.last.device}: ${describeMatch(match)}`);
      // Control: the same output against the hand boxes moved by a third of the image must fail.
      const moved = HAND.boxes.map(b => ({ label: b.label, box: { xmin: b.box.xmin - 320, ymin: b.box.ymin, xmax: b.box.xmax - 320, ymax: b.box.ymax } }));
      t.ok(!matchToHand(r.last.objects, moved).ok, 'control: boxes in the wrong place do not match');
      await primarySays(page, s['action.run']);
      f = await facts(page);
      t.equal(f.primary, s['action.run'], 'primary label once the model is stored');
      t.equal(f.status, s['status.done'], 'status line');
      t.ok(f.summary.includes(s['device.' + r.last.device]), `the summary names the backend: ${f.summary}`);
      const atHalf = r.last.objects.filter(o => o.score >= 0.5);
      t.equal(listed(f), atHalf.map(o => o.label), 'the list holds the objects at the default threshold, highest score first');
      const names = JSON.parse(readFileSync(join(ROOT, 'apps', 'detect', 'labels.es.json'), 'utf8'));
      t.ok(f.items.every(i => !i.label || i.text.startsWith(names[i.label] + ' · ')), `Spanish names in the list: ${JSON.stringify(f.items.map(i => i.text))}`);
      t.equal([f.overlay.width, f.overlay.height], [HAND.width, HAND.height], 'overlay canvas at the size of the photo');
      t.ok(Math.abs(f.overlay.w - f.image.w) <= 1 && Math.abs(f.overlay.h - f.image.h) <= 1 && Math.abs(f.overlay.x - f.image.x) <= 1 && Math.abs(f.overlay.y - f.image.y) <= 1, `the overlay lies on the picture: ${JSON.stringify([f.overlay, f.image])}`);
      t.ok(f.painted > 0, 'boxes are drawn');
      t.equal([f.resultHidden, f.downloadsHidden, f.styleAttrs], [false, false, 0], 'result shown, downloads offered, no inline style');
      // The slider filters what was found; the model does not run again.
      const want = {}, got = {};
      for (const v of [0.9, 0.3, 0.5]) {
        await setSlider(page, v);
        want[v] = r.last.objects.filter(o => o.score >= v).map(o => o.label);
        got[v] = listed(await facts(page));
      }
      t.equal(got, want, 'the list follows the slider');
      t.equal((await hook(page)).runs, r.runs, 'moving the slider never runs the model');
      // Downloads.
      const [dj] = await Promise.all([page.waitForEvent('download'), page.click(sel.json)]);
      const json = JSON.parse(readFileSync(await dj.path(), 'utf8'));
      t.equal(dj.suggestedFilename(), 'foto-objetos.json', 'JSON file name');
      t.equal([json.source, json.model, json.device, json.threshold, json.width, json.height], ['foto.jpg', site.models[0], r.last.device, 0.5, HAND.width, HAND.height], 'JSON header');
      t.equal(json.objects.map(o => o.label), atHalf.map(o => o.label), 'JSON objects, with the English names');
      t.ok(matchToHand(json.objects, HAND.boxes).ok, 'the JSON boxes still meet the hand boxes');
      const [dp] = await Promise.all([page.waitForEvent('download'), page.click(sel.png)]);
      t.equal(dp.suggestedFilename(), 'foto-cajas.png', 'PNG file name');
      t.equal(pngSize(readFileSync(await dp.path())), [HAND.width, HAND.height], 'the PNG has the size of the photo');
      t.equal(t.hubFull(), variantUrls(t, site), 'downloaded exactly the files of the variant, once each');
      t.equal(t.hub.counts.full.length, t.hubFull().length, 'no file downloaded twice');
      // The English page, on the same profile: the model comes from the store.
      await t.noCsp(page);
      t.hub.reset();
      const en = await openApp(t, ctx, site, '/en/');
      const r2 = await detectPhoto(en);
      await primarySays(en, t.strings[site.site].en['action.run']);
      const fe = await facts(en);
      t.ok(r2.last && matchToHand(r2.last.objects, HAND.boxes).ok, 'English page: the same objects');
      t.ok(fe.items.length > 0 && fe.items.every(i => !i.label || i.text.startsWith(i.label + ' · ')), `English names in the list: ${JSON.stringify(fe.items.map(i => i.text))}`);
      t.equal(fe.primary, t.strings[site.site].en['action.run'], 'English primary label: nothing to download');
      t.equal(t.hubTotal(), 0, 'the second page downloads nothing: whole files or probes');
      t.equal(fe.status, t.strings[site.site].en['status.done'], 'English status line');
      await t.noCsp(en);
      t.noPageErrors();
      t.networkClean(site);
    },
  },
  {
    name: 'the camera: three consecutive frames meet the hand boxes; Stop ends the tracks',
    sites: ['detect'],
    async run(t, site) {
      const video = await cameraVideo(t, site);
      const ctx = await cameraContext(t, { y4m: video });
      const page = await openApp(t, ctx, site, '/');
      const s = t.strings[site.site].es;
      // Count the requests for a camera: two quick clicks must open one camera, not two.
      await page.evaluate(() => {
        const md = navigator.mediaDevices;
        const ask = md.getUserMedia.bind(md);
        globalThis.__cameraAsks = 0;
        md.getUserMedia = c => { globalThis.__cameraAsks++; return ask(c); };
      });
      await page.dblclick(sel.camera);
      await page.waitForFunction(() => {
        const v = document.querySelector('[data-role="video"]');
        return !v.hidden && v.readyState >= 2 && v.videoWidth > 0;
      }, null, { timeout: 60000 });
      let f = await facts(page);
      t.equal(await page.evaluate(() => globalThis.__cameraAsks), 1, 'two quick clicks ask for one camera');
      t.equal(f.status, s['camera.ready'], 'camera ready');
      t.equal([f.cameraHidden, f.stopHidden, f.primaryDisabled], [true, false, false], 'Stop offered, primary ready');
      await page.click(sel.primary);
      await page.waitForFunction(() => globalThis.__elffuss.detect.frames.length >= 3 || globalThis.__elffuss.errors.length > 0, null, { timeout: 600000 });
      let h = await hook(page);
      if (!t.ok(h.frames.length >= 3, `three frames: ${JSON.stringify(h.errors)}`)) return;
      const want = expectedDevice(site, t.registry, t.config);
      h.frames.slice(0, 3).forEach((fr, i) => {
        const m = matchToHand(fr.objects, normalizedHand(HAND));
        t.ok(m.ok, `frame ${i + 1} (${fr.width}×${fr.height}) against the hand boxes: ${describeMatch(m)}`);
        t.equal(fr.device, want, `frame ${i + 1} backend`);
        if (i === 0) t.note(`camera ${fr.width}×${fr.height}: ${describeMatch(m)}`);
      });
      f = await facts(page);
      t.equal(f.status, s['camera.live'], 'status while detecting');
      t.ok(f.painted > 0 && !f.video.hidden, 'boxes drawn over the live picture');
      await page.click(sel.stop);
      await page.waitForFunction(() => !document.querySelector('main button.primary').disabled, null, { timeout: 120000 });
      h = await hook(page);
      t.ok(h.tracks.length > 0 && h.tracks.every(x => x === 'ended'), `tracks after Stop: ${JSON.stringify(h.tracks)}`);
      const runs = h.runs;
      await page.waitForTimeout(1500);
      t.equal((await hook(page)).runs, runs, 'no frame is analysed after Stop');
      f = await facts(page);
      t.equal([f.video.hidden, f.frame.hidden, f.cameraHidden, f.stopHidden], [true, false, false, true], 'the last frame stays, the camera can be opened again');
      t.equal(f.status, s['camera.stopped'], 'status after Stop');
      t.equal(await page.evaluate(() => document.querySelector('[data-role="video"]').srcObject), null, 'the video lets go of the stream');
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
    },
  },
  {
    name: 'only this site may open the camera, and a refused camera is explained',
    sites: ['detect'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await cameraContext(t);
      const other = t.sites.find(x => !x.catalog && x.site !== site.site);
      const ask = page => page.evaluate(async () => {
        const allowed = document.featurePolicy ? document.featurePolicy.allowsFeature('camera') : null;
        try {
          const st = await navigator.mediaDevices.getUserMedia({ video: true });
          st.getTracks().forEach(x => x.stop());
          return { allowed, opened: true };
        } catch (e) { return { allowed, opened: false, error: e.name }; }
      });
      const p1 = await t.open(ctx, other, '/licencias/', { wait: 'load' });
      const o = await ask(p1);
      t.equal([o.allowed, o.opened, o.error], [false, false, 'NotAllowedError'], `${other.site} cannot open the camera`);
      const p2 = await t.open(ctx, site, '/licencias/', { wait: 'load' });
      const d = await ask(p2);
      t.equal([d.allowed, d.opened], [true, true], `${site.site} can open the camera`);
      // A refusal is explained in the status line, in the words that fit what the browser said:
      // Chrome refuses with NotAllowedError; the bundled headless Chromium has no camera prompt
      // and answers NotSupportedError.
      const denied = await cameraContext(t, { deny: true });
      const said = await ask(await t.open(denied, site, '/licencias/', { wait: 'load' }));
      t.equal(said.opened, false, 'the browser refuses the camera');
      if (t.browser === 'chrome') t.equal(said.error, 'NotAllowedError', 'Chrome says the permission was denied');
      else t.note(`${t.browser} refuses with ${said.error}`);
      const page = await openApp(t, denied, site, '/');
      await page.click(sel.camera);
      const s = t.strings[site.site].es;
      const want = s[cameraErrorKey({ name: said.error })];
      await page.waitForFunction(text => document.querySelector('main p.status').textContent === text, want, { timeout: 30000 }).catch(() => {});
      const f = await facts(page);
      t.equal(f.status, want, 'refused camera, explained');
      t.equal([f.cameraHidden, f.stopHidden], [false, true], 'the camera button stays');
      t.noPageErrors();
    },
  },
  {
    name: 'an explicit backend is honoured or refused, visibly',
    sites: ['detect'],
    async run(t, site) {
      const ctx = await t.newContext();
      const m = t.registry.models[site.models[0]];
      let code = null;
      try { chooseVariant(m, 'webgpu', t.probe); } catch (e) { code = e.code; }
      const page = await openApp(t, ctx, site, '/?device=webgpu');
      const f = await facts(page);
      const s = t.strings[site.site].es;
      if (code) t.equal(f.status, s['error.' + code], `?device=webgpu says ${code}`);
      else t.equal(f.status, s['pick.first'], '?device=webgpu is accepted');
      const p2 = await openApp(t, ctx, site, '/?device=wasm');
      const r = await detectPhoto(p2);
      t.equal(r.last?.device, 'wasm', '?device=wasm runs on WebAssembly');
      t.ok(r.last && matchToHand(r.last.objects, HAND.boxes).ok, 'and finds the objects');
      t.noPageErrors();
    },
  },
  {
    name: 'a failure inside the runtime is shown, and the next run works',
    sites: ['detect'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await openApp(t, ctx, site, '/?test-fail=run');
      const s = t.strings[site.site].es;
      const r1 = await detectPhoto(page);
      t.ok(r1.errors.includes('run-failed'), `first run fails on purpose: ${JSON.stringify(r1.errors)}`);
      t.equal((await facts(page)).status, s['error.run-failed'], 'and the page says so');
      await page.click(sel.primary);
      await page.waitForFunction(() => globalThis.__elffuss.detect.runs >= 1 && !document.querySelector('main button.primary').disabled, null, { timeout: 600000 });
      const r2 = await hook(page);
      t.ok(r2.last && matchToHand(r2.last.objects, HAND.boxes).ok, 'the second run works');
      t.equal(t.hub.counts.full.length, t.hubFull().length, 'the new Worker read the model from the store');
      t.noPageErrors();
    },
  },
  {
    name: 'the decoder\'s reference outputs are what the model gives today',
    sites: ['detect'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await openApp(t, ctx, site, '/');
      const out = await captureOutputs(page);
      if (!t.ok(out?.logits?.length, 'raw outputs')) return;
      const m = t.registry.models[site.models[0]];
      const part = m.parts.main;
      const fresh = {
        model: site.models[0], repo: part.repo, revision: part.revision, device: out.info.device, dtype: out.info.dtype,
        image: 'tests/fixtures/detect/foto.jpg', width: out.width, height: out.height, queries: out.queries, classes: out.classes,
        id2label: out.id2label,
        rows: topRows({ logits: out.logits, boxes: out.boxes, classes: out.classes, queries: out.queries, named: out.named, rows: out.rows }),
      };
      const config = JSON.parse(readFileSync(join(t.cache, 'hf', ...part.repo.split('/'), part.revision, 'config.json'), 'utf8'));
      t.equal(fresh.id2label, config.id2label, 'class names as in the pinned config');
      const names = JSON.parse(readFileSync(join(ROOT, 'apps', 'detect', 'labels.es.json'), 'utf8'));
      t.equal(Object.keys(names).sort(), Object.values(config.id2label).sort(), 'labels.es.json names every class of the model, and only those');
      if (process.env.ELFFUSS_AI_UPDATE_DETECT_OUTPUTS === '1') {
        writeFileSync(GOLDEN, JSON.stringify(fresh, null, 1) + '\n');
        t.note('reference outputs written');
        return;
      }
      const saved = JSON.parse(readFileSync(GOLDEN, 'utf8'));
      t.equal([saved.revision, saved.device, saved.dtype, saved.queries, saved.classes], [fresh.revision, fresh.device, fresh.dtype, fresh.queries, fresh.classes], 'same model, backend and shape');
      t.equal(saved.rows.slice(0, 2).map(x => x.query), fresh.rows.slice(0, 2).map(x => x.query), 'the same two best queries');
      let worst = 0;
      for (const row of saved.rows.slice(0, 2)) {
        const now = fresh.rows.find(x => x.query === row.query);
        for (let k = 0; k < row.logits.length; k++) worst = Math.max(worst, Math.abs(row.logits[k] - now.logits[k]));
        for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(row.box[k] - now.box[k]) * 10);
      }
      t.ok(worst < 0.05, `the saved outputs of the two best queries are within tolerance (worst ${worst})`);
    },
  },
  {
    // A small labelled check of recall: every object drawn by hand on the
    // repository's photos is found, with the scores the normalised input gives,
    // and the photo without objects gets none. It fails with the input the
    // model's config describes (x/255, without the normalisation).
    name: 'recall on the labelled photos, with the input the model was trained on',
    sites: ['detect'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await openApp(t, ctx, site, '/');
      const found = [];
      for (const item of labelledSet()) {
        const r = await detectPhoto(page, item.photo);
        if (!t.ok(r.last, `${item.name}: no result: ${JSON.stringify(r.errors)}`)) continue;
        const m = matchToHand(r.last.objects, item.boxes, { minIou: RECALL.minIou, minScore: RECALL.minScore });
        t.ok(m.misses.length === 0, `${item.name}: every hand-labelled object found (${describeMatch(m)})`);
        t.ok(m.extra.length === 0, `${item.name}: nothing else at 0.7 or more (${describeMatch(m)})`);
        found.push(`${item.name}: ${describeMatch(m) || 'nothing'}`);
        if (item.name === 'detect/foto.jpg') {
          const cats = r.last.objects.filter(o => o.label === 'cat').sort((a, b) => b.score - a.score);
          t.ok(cats[0]?.score >= RECALL.catScore, `the cat scores ${cats[0]?.score?.toFixed(3)}, at least ${RECALL.catScore}`);
          t.ok(!(cats[1]?.score >= RECALL.duplicate), `no second cat at ${RECALL.duplicate} or more (${cats[1]?.score?.toFixed(3) ?? 'none'})`);
        }
      }
      t.note(found.join(' | '));
      t.noPageErrors();
      await t.noCsp(page);
    },
  },
  {
    name: 'large photos: refused over the pixel budget before decoding; the PNG with boxes is capped and always saved',
    sites: ['detect'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await openApp(t, ctx, site, '/');
      const s = t.strings[site.site].es;
      // A picture of 20000 × 20000 px in a file of a few kilobytes.
      const be = n => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
      const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be(13), Buffer.from('IHDR'), be(20000), be(20000), Buffer.from([8, 6, 0, 0, 0]), be(0), be(0), Buffer.from('IEND'), be(0)]);
      const before = await page.evaluate(() => globalThis.__elffuss.errors.length);
      await page.setInputFiles(sel.input, { name: 'enorme.png', mimeType: 'image/png', buffer: bomb });
      await page.waitForFunction(n => globalThis.__elffuss.errors.length > n, before, { timeout: 30000 });
      const f = await facts(page);
      t.equal([f.status, f.primaryDisabled], [s['error.too-large'], true], 'refused before decoding, nothing enabled');
      t.equal(t.hubTotal(), 0, 'nothing downloaded');
      // A wide photo of 6000 px: detected, and its PNG with boxes saved at 4096 px.
      const wide = await page.evaluate(async b64 => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
        const c = new OffscreenCanvas(6000, 4500);
        c.getContext('2d').drawImage(bmp, 0, 0, 6000, 4500);
        const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
        let x = '';
        for (let i = 0; i < bytes.length; i += 0x8000) x += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(x);
      }, readFileSync(PHOTO).toString('base64'));
      const r = await detectPhoto(page, { name: 'grande.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(wide, 'base64') });
      t.equal([r.last?.width, r.last?.height], [6000, 4500], 'boxes in pixels of the photo');
      const scaled = { boxes: HAND.boxes.map(b => ({ label: b.label, box: Object.fromEntries(Object.entries(b.box).map(([k, v]) => [k, v * 6000 / HAND.width])) })) };
      t.ok(matchToHand(r.last?.objects || [], scaled.boxes).ok, 'the same objects, at the larger size');
      const shown = await page.evaluate(() => { const i = document.querySelector('[data-role="image"]'); const o = document.querySelector('[data-role="overlay"]'); return { natural: [i.naturalWidth, i.naturalHeight], overlay: [o.width, o.height] }; });
      t.ok(Math.max(...shown.natural) <= 2048 && Math.max(...shown.overlay) <= 2048, `the page shows a small copy and a small overlay: ${JSON.stringify(shown)}`);
      const [dp] = await Promise.all([page.waitForEvent('download'), page.click(sel.png)]);
      t.equal(pngSize(readFileSync(await dp.path())), [4096, 3072], 'the PNG with boxes is saved at 4096 px on its long side');
      t.noPageErrors();
    },
  },
];
