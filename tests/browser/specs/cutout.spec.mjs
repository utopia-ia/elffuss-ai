// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// cutout.elffuss.com through its real page, in both configurations: choose the
// photo, press the button, and check the output itself. The downloaded PNG has
// alpha and the photo's size and keeps its colours; its mask matches the
// polygon traced by hand (IoU ≥ 0.85) and the reference mask of BEN2 fp16 on
// WebAssembly (IoU ≥ 0.98, mean alpha error ≤ 0.01); the comparison slider and
// the download work; the backend is WebAssembly with no fallback. Then: an
// explicit WebGPU request is refused, inputs that are not images are refused
// before any download, paste and drop choose an image, cancel stops the
// download and the next run resumes, a failure inside the runtime is followed by
// a working run, an image with an Exif orientation comes out upright, one longer
// than 4096 px is scaled down and the card says so, one over the pixel budget is
// refused before it is decoded, a browser that cannot give BEN2 its WebAssembly
// heap says so before downloading anything; and a canary runs BEN2 on WebGPU
// anyway, to learn when the pinned ONNX Runtime stops failing on it.
//
// ELFFUSS_AI_RECORD=cutout writes tests/fixtures/cutout/golden-alpha.png from
// the configuration B run (WebAssembly, the reference backend) instead of
// comparing with it; its hash then goes to tests/fixtures/SOURCES.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chooseVariant, isShaderError } from '../../../sdk/core/device.js';
import { variantFiles } from '../../../sdk/core/registry.js';
import { fill } from '../../../scripts/lib/template.mjs';
import { formatMB } from '../../../scripts/lib/pages.mjs';

const FIX = fileURLToPath(new URL('../../fixtures/cutout/', import.meta.url));
const RUN_TIMEOUT = 20 * 60 * 1000; // a first run downloads the model and runs it on one WebAssembly thread
export const THRESHOLDS = Object.freeze({ polygonIoU: 0.85, referenceIoU: 0.98, referenceMeanError: 0.01, colourError: 1 });

// ── PNG, masks and photos, in Node ───────────────────────────────────────────

/**
 * Decode a PNG of 8 bits per channel (grey, RGB, grey and alpha, or RGBA; not interlaced).
 * @param {Uint8Array} buf
 * @returns {{ width: number, height: number, channels: number, colorType: number, data: Uint8Array }}
 */
export function decodePng(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!SIG.every((v, i) => b[i] === v)) throw new Error('not a PNG');
  let p = 8, width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), kind = b.toString('latin1', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${interlace}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0, i = 0; y < height; y++) {
    const f = raw[i++], row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++, i++) {
      const a = x >= channels ? out[row + x - channels] : 0;
      const up = y ? out[prev + x] : 0;
      const c = y && x >= channels ? out[prev + x - channels] : 0;
      let v = raw[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      out[row + x] = v & 255;
    }
  }
  return { width, height, channels, colorType: type, data: out };
}

/** A grey PNG (8 bits, no filter) of `data`, one byte per pixel. */
export function encodeGreyPng(width, height, data) {
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) rows.set(data.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const chunk = (kind, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(kind, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; colour type 0 (grey), no interlace
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The alpha channel of a decoded PNG (all 255 when it has none). */
export function alphaOf(png) {
  const n = png.width * png.height;
  if (png.channels === 2 || png.channels === 4) {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = png.data[i * png.channels + png.channels - 1];
    return a;
  }
  return new Uint8Array(n).fill(255);
}

/** The first channel of a decoded PNG (a grey reference). */
export function greyOf(png) {
  const n = png.width * png.height;
  const g = new Uint8Array(n);
  for (let i = 0; i < n; i++) g[i] = png.data[i * png.channels];
  return g;
}

/**
 * Fill polygons with the even-odd rule, sampling pixel centres: 255 inside, 0 outside.
 * @param {number[][][]} polygons rings of [x, y] points in pixels
 */
export function rasterize(polygons, width, height) {
  const mask = new Uint8Array(width * height);
  const edges = [];
  for (const ring of polygons) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i], [x1, y1] = ring[(i + 1) % ring.length];
      if (y0 !== y1) edges.push([x0, y0, x1, y1]);
    }
  }
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    const xs = [];
    for (const [x0, y0, x1, y1] of edges) if ((cy >= y0) !== (cy >= y1)) xs.push(x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0));
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5)), to = Math.min(width - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) mask[y * width + x] = 255;
    }
  }
  return mask;
}

/** Intersection over union of two masks, each pixel in when its value is at least `threshold`. */
export function iou(a, b, threshold = 128) {
  if (a.length !== b.length) throw new Error('masks of different sizes');
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] >= threshold, y = b[i] >= threshold;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : 1;
}

/** Mean absolute difference of two alpha masks, from 0 to 1. */
export function meanAbsError(a, b) {
  if (a.length !== b.length) throw new Error('masks of different sizes');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return a.length ? s / (255 * a.length) : 0;
}

/**
 * The same JPEG with an Exif block saying "rotate 90° clockwise to display"
 * (orientation 6), inserted after the start marker; the image data is untouched.
 */
export function withOrientation(jpg, orientation = 6) {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // little endian, first IFD at 8
    0x01, 0x00, // one entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, // Orientation, SHORT, 1, value
    0x00, 0x00, 0x00, 0x00]); // no next IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
}

/** Width and height of a JPEG, from its frame header. */
export function jpegSize(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) throw new Error('bad JPEG marker');
    const m = buf[p + 1], len = (buf[p + 2] << 8) | buf[p + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: (buf[p + 5] << 8) | buf[p + 6], width: (buf[p + 7] << 8) | buf[p + 8] };
    p += 2 + len;
  }
  throw new Error('no JPEG frame header');
}

// ── the page ────────────────────────────────────────────────────────────────

/** What the page shows, read in the browser. */
export function cutoutFacts(page) {
  return page.evaluate(() => {
    const q = s => document.querySelector(s);
    const primary = q('main button.primary');
    const e = globalThis.__elffuss;
    return {
      primary: { text: primary?.textContent ?? null, disabled: primary?.disabled ?? null },
      status: q('main p.status')?.textContent ?? null,
      chosen: q('[data-role="chosen"]')?.textContent ?? null,
      previewHidden: q('[data-role="preview"]')?.hidden ?? null,
      cancelHidden: q('[data-action="cancel"]')?.hidden ?? null,
      resultHidden: q('main section.result')?.hidden ?? null,
      cards: document.querySelectorAll('main section.result article.card').length,
      title: q('main section.result article.card h3')?.textContent ?? null,
      facts: q('main section.result [data-role="facts"]')?.textContent ?? null,
      notes: [...document.querySelectorAll('main section.result [data-role="note"]')].map(n => n.textContent),
      buttons: [...document.querySelectorAll('button')].map(b => b.className),
      styleAttrs: document.querySelectorAll('[style]').length,
      diag: e ? JSON.parse(JSON.stringify({ device: e.device, fallback: e.fallback, errors: e.errors, cutout: e.cutout ?? null })) : null,
    };
  });
}

/** Press the primary button and wait until the run gives a result or an error. */
async function pressAndWait(page) {
  const before = await page.evaluate(() => ({ runs: globalThis.__elffuss?.cutout?.runs ?? 0, errors: globalThis.__elffuss?.errors?.length ?? 0 }));
  await page.click('main button.primary');
  await page.waitForFunction(b => (globalThis.__elffuss?.cutout?.runs ?? 0) > b.runs || (globalThis.__elffuss?.errors?.length ?? 0) > b.errors, before, { timeout: RUN_TIMEOUT });
  await page.waitForFunction(() => !document.querySelector('main button.primary').disabled || !document.querySelector('main section.result').hidden, null, { timeout: 60000 });
}

const variantUrls = (t, site) => {
  const m = t.registry.models[site.models[0]];
  return variantFiles(m, chooseVariant(m, 'auto', t.probe).variant).map(f => f.url).sort();
};

const photo = () => readFileSync(join(FIX, 'foto.jpg'));

/** Colour check in the browser: where the PNG is opaque, its RGB is the photo's. */
function colourError(page, pngB64, jpgB64) {
  return page.evaluate(async ([png, jpg]) => {
    const bytes = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const read = async (b, type) => {
      const bmp = await createImageBitmap(new Blob([b], { type }), { premultiplyAlpha: 'none' });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0);
      return x.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const out = await read(bytes(png), 'image/png'), src = await read(bytes(jpg), 'image/jpeg');
    let s = 0, n = 0;
    for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 255) { s += Math.abs(out[i] - src[i]) + Math.abs(out[i + 1] - src[i + 1]) + Math.abs(out[i + 2] - src[i + 2]); n += 3; }
    return { mean: n ? s / n : null, opaque: n / 3 };
  }, [pngB64, jpgB64]);
}

/** The photo's RGBA as the browser decodes it (opaque, so a canvas gives it back exactly). */
async function photoRgba(page, jpgB64) {
  const b64 = await page.evaluate(async jpg => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(jpg), c => c.charCodeAt(0))], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
    return btoa(s);
  }, jpgB64);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** A valid-looking PNG header of w × h pixels with almost no data: a decoder bomb. */
function hugePng(w, h) {
  const be = n => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const ihdr = Buffer.concat([be(13), Buffer.from('IHDR'), be(w), be(h), Buffer.from([8, 6, 0, 0, 0]), be(0)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, be(0), Buffer.from('IEND'), be(0)]);
}

/** Pixels of the comparison canvas at points given as fractions of its size, after setting the slider. */
function comparePixels(page, value, points) {
  return page.evaluate(([v, pts]) => {
    const range = document.querySelector('main section.result input[type="range"]');
    range.value = String(v);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    const c = document.querySelector('main section.result canvas');
    const x = c.getContext('2d');
    return pts.map(([fx, fy]) => [...x.getImageData(Math.floor(fx * c.width), Math.floor(fy * c.height), 1, 1).data]);
  }, [value, points]);
}

export default [
  {
    name: 'cutout: the photo comes out with a transparent background, checked against the hand polygon and the reference',
    sites: ['cutout'],
    async run(t, site) {
      const ctx = await t.newContext();
      // Spanish in A and English in B, so a full run covers both pages.
      const lang = t.config === 'A' ? 'es' : 'en';
      const s = t.strings[site.site][lang];
      const page = await t.open(ctx, site, lang === 'es' ? '/' : '/en/');
      await page.waitForFunction(() => document.querySelector('main p.status').textContent.length > 0);
      const m = t.registry.models[site.models[0]];
      const choice = chooseVariant(m, 'auto', t.probe);
      let f = await cutoutFacts(page);
      t.equal(f.primary, { text: fill(s['action.downloadAndRun'], { size: `${formatMB(choice.variant.bytes, lang)} MB` }), disabled: true }, 'before choosing: the button says what it downloads, and waits for an image');
      t.equal(f.status, s['choose.prompt'], 'the page asks for an image');

      const jpg = photo();
      const { width: W, height: H } = jpegSize(jpg);
      await page.setInputFiles('main label.drop input[type="file"]', join(FIX, 'foto.jpg'));
      await page.waitForFunction(() => !document.querySelector('[data-role="preview"]').hidden);
      f = await cutoutFacts(page);
      t.equal(f.chosen, fill(s.chosen, { name: 'foto.jpg', width: W, height: H }), 'the chosen image is named, with its size');
      t.equal(f.primary.disabled, false, 'the button is ready');
      t.equal(t.hubTotal(), 0, 'choosing an image downloads nothing');

      await pressAndWait(page);
      // The store is asked again after every run; the label follows its answer.
      await page.waitForFunction(text => document.querySelector('main button.primary').textContent === text, s['action.run'], { timeout: 30000 }).catch(() => {});
      f = await cutoutFacts(page);
      if (!t.ok(f.diag?.cutout?.runs === 1, `the run gave a result: ${JSON.stringify({ status: f.status, errors: f.diag?.errors })}`)) return;
      t.equal([f.diag.device, f.diag.fallback], ['wasm', null], 'it ran on WebAssembly, with no fallback');
      t.equal(f.facts, `${s['device.wasm']} · ${fill(s['result.size'], { width: W, height: H })}`, 'the card says the backend and the size');
      t.equal(f.notes, [], 'no notes: not scaled, not empty, no fallback');
      t.equal(f.title, `foto-${s['download.suffix']}.png`, 'the card is named after the file it gives');
      t.equal(f.primary, { text: s['action.run'], disabled: false }, 'after the run the model is stored: the button no longer downloads');
      t.equal(f.cancelHidden, true, 'cancel is hidden again');
      t.equal(f.status, s['status.done'], 'the status line says it is done, not that the image is ready');
      t.equal(f.previewHidden, true, 'the comparison replaces the preview');
      t.ok(f.buttons.filter(c => c === 'primary').length === 1 && f.buttons.every(c => c === 'primary' || c === 'ghost'), `one primary button, the rest ghost: ${f.buttons}`);
      t.equal(f.styleAttrs, 0, 'no style attributes after a full run');

      // The download is the result: a PNG with alpha at the photo's size.
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('main section.result [data-action="download"]')]);
      t.equal(download.suggestedFilename(), `foto-${s['download.suffix']}.png`, 'download name');
      const pngBytes = readFileSync(await download.path());
      const png = decodePng(pngBytes);
      t.equal([png.width, png.height], [W, H], 'the PNG has the photo\'s size');
      t.ok(png.channels === 4 || png.channels === 2, `the PNG has an alpha channel (colour type ${png.colorType})`);
      const alpha = alphaOf(png);

      // Against the polygon traced by hand.
      const ref = JSON.parse(readFileSync(join(FIX, 'mascara.json'), 'utf8'));
      t.equal([ref.width, ref.height], [W, H], 'the polygon is in the photo\'s pixels');
      const byHand = iou(alpha, rasterize(ref.polygons, W, H));
      t.ok(byHand >= THRESHOLDS.polygonIoU, `IoU with the hand polygon ${byHand.toFixed(4)} ≥ ${THRESHOLDS.polygonIoU}`);

      // Against the reference mask of BEN2 fp16 on WebAssembly.
      const goldenPath = join(FIX, 'golden-alpha.png');
      if (process.env.ELFFUSS_AI_RECORD === 'cutout' && t.config === 'B') {
        const out = encodeGreyPng(W, H, alpha);
        writeFileSync(goldenPath, out);
        t.note(`recorded golden-alpha.png, sha256 ${createHash('sha256').update(out).digest('hex')}`);
      } else if (t.ok(existsSync(goldenPath), 'golden-alpha.png exists (ELFFUSS_AI_RECORD=cutout makes it)')) {
        const golden = decodePng(readFileSync(goldenPath));
        t.equal([golden.width, golden.height], [W, H], 'reference size');
        const g = greyOf(golden);
        const ri = iou(alpha, g), me = meanAbsError(alpha, g);
        t.ok(ri >= THRESHOLDS.referenceIoU, `IoU with the reference ${ri.toFixed(4)} ≥ ${THRESHOLDS.referenceIoU}`);
        t.ok(me <= THRESHOLDS.referenceMeanError, `mean alpha error against the reference ${me.toFixed(5)} ≤ ${THRESHOLDS.referenceMeanError}`);
        t.note(`IoU hand ${byHand.toFixed(4)}, reference ${ri.toFixed(4)}, mean alpha error ${me.toFixed(5)}`);
      }

      // Where the PNG is opaque, its colours are the photo's.
      const colours = await colourError(page, pngBytes.toString('base64'), jpg.toString('base64'));
      t.ok(colours.opaque > 0.1 * W * H && colours.mean !== null && colours.mean <= THRESHOLDS.colourError, `opaque pixels keep the photo's colours: ${JSON.stringify(colours)}`);
      // And so do the half-transparent ones of the edge, read from the file itself
      // (a canvas would premultiply them on the way in and change them).
      if (png.channels === 4) {
        const src = await photoRgba(page, jpg.toString('base64'));
        let sum = 0, n = 0, worst = 0;
        for (let i = 0; i < W * H; i++) {
          const a = png.data[i * 4 + 3];
          if (a === 0 || a === 255) continue;
          for (let c = 0; c < 3; c++) { const d = Math.abs(png.data[i * 4 + c] - src[i * 4 + c]); sum += d; worst = Math.max(worst, d); }
          n++;
        }
        t.ok(n > 500 && sum / (3 * n) <= THRESHOLDS.colourError, `half-transparent pixels keep the photo's colours: ${n} pixels, mean error ${(sum / (3 * n)).toFixed(3)}, worst ${worst}`);
      }

      // The comparison: the original left of the split, the cut-out over the checkerboard right of it.
      const grass = [0.05, 0.05], dog = [460 / W, 330 / H];
      const atOriginal = await comparePixels(page, 100, [grass, dog]);
      const atCutout = await comparePixels(page, 0, [grass, dog]);
      // The two checkerboard colours, as the page resolves its variables.
      const checker = await page.evaluate(() => ['--bg2', '--bg3'].map(v => {
        const c = new OffscreenCanvas(1, 1).getContext('2d');
        c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        c.fillRect(0, 0, 1, 1);
        return [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      }));
      const near = (px, cs) => cs.some(c => c.every((v, i) => Math.abs(v - px[i]) <= 3));
      t.ok(near(atCutout[0], checker), `with the slider at 0 the grass is the checkerboard (${atCutout[0]}; ${JSON.stringify(checker)})`);
      t.ok(!near(atOriginal[0], checker) && atOriginal[0][1] > atOriginal[0][0], `with the slider at 100 the grass is the photo's (${atOriginal[0]})`);
      t.ok(atCutout[1].slice(0, 3).every((v, i) => Math.abs(v - atOriginal[1][i]) <= 2), `the dog looks the same on both sides (${atCutout[1]} vs ${atOriginal[1]})`);
      // Dragging on the picture moves the slider.
      await page.locator('main section.result canvas').scrollIntoViewIfNeeded();
      const box = await page.locator('main section.result canvas').boundingBox();
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      const dragged = Number(await page.locator('main section.result input[type="range"]').inputValue());
      t.ok(Math.abs(dragged - 75) <= 2, `dragging moves the split (slider at ${dragged})`);

      t.equal(t.hubFull(), variantUrls(t, site), 'downloaded exactly the files of the variant');
      t.equal(t.hub.counts.full.length, t.hubFull().length, 'each file once');
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);

      // The catalog now says the tool's model is in this browser.
      const tools = t.sites.find(x => x.catalog);
      const cat = await t.open(ctx, tools, lang === 'es' ? '/' : '/en/');
      const marks = await cat.evaluate(() => globalThis.__elffuss?.marks);
      t.equal(marks?.cutout, true, 'the catalog card of cutout says the model is already here');
      t.note(`${W}×${H}, coverage ${f.diag.cutout.coverage.toFixed(3)}, PNG ${pngBytes.length} bytes`);
    },
  },
  {
    name: 'cutout: ?device=webgpu says device-unsupported, keeps the button off and downloads nothing',
    sites: ['cutout'],
    async run(t, site) {
      const ctx = await t.newContext();
      const s = t.strings[site.site].es;
      const page = await t.open(ctx, site, '/?device=webgpu');
      let f = await cutoutFacts(page);
      t.equal(f.status, s['error.device-unsupported'], 'the page says the model only works with WASM');
      await page.setInputFiles('main label.drop input[type="file"]', join(FIX, 'foto.jpg'));
      await page.waitForFunction(() => !document.querySelector('[data-role="preview"]').hidden);
      f = await cutoutFacts(page);
      t.equal(f.status, s['error.device-unsupported'], 'still said after choosing an image');
      t.equal(f.primary.disabled, true, 'the button stays off');
      t.equal(t.hubTotal(), 0, 'nothing is downloaded');
      t.noPageErrors();
    },
  },
  {
    name: 'cutout: files that are not images are refused at once; paste and drop choose an image',
    sites: ['cutout'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const s = t.strings[site.site].es;
      const page = await t.open(ctx, site, '/');
      const input = 'main label.drop input[type="file"]';
      const cases = [
        { name: 'notas.jpg', buffer: Buffer.from('not an image at all'), code: 'unsupported-format' },
        { name: 'foto.heic', buffer: Buffer.from([0, 0, 0, 0x18, ...Buffer.from('ftypheic'), ...new Array(16).fill(0)]), code: 'unsupported-format' },
        { name: 'rota.png', buffer: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('garbage after the signature')]), code: 'decode-failed' },
      ];
      for (const c of cases) {
        await page.setInputFiles(input, { name: c.name, mimeType: 'image/jpeg', buffer: c.buffer });
        await page.waitForFunction(text => document.querySelector('main p.status').textContent === text, s[`error.${c.code}`], { timeout: 10000 }).catch(() => {});
        const f = await cutoutFacts(page);
        t.equal([f.status, f.primary.disabled, f.previewHidden], [s[`error.${c.code}`], true, true], `${c.name}: ${c.code}, button off, no preview`);
      }
      const b64 = photo().toString('base64');
      // Paste: the shell names a pasted image pegado-N.
      await page.evaluate(data => {
        const file = new File([Uint8Array.from(atob(data), ch => ch.charCodeAt(0))], 'image.jpg', { type: 'image/jpeg' });
        const dt = new DataTransfer();
        dt.items.add(file);
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, b64);
      await page.waitForFunction(() => !document.querySelector('[data-role="preview"]').hidden);
      let f = await cutoutFacts(page);
      t.equal(f.chosen, fill(s.chosen, { name: 'pegado-1.jpg', width: 960, height: 640 }), 'a pasted image is chosen');
      t.equal([f.status, f.primary.disabled], [s['chosen.ready'], false], 'and the button is ready');
      // Drop two files: the first is taken and the page says so.
      await page.evaluate(data => {
        const bytes = Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'primera.jpg', { type: 'image/jpeg' }));
        dt.items.add(new File([bytes], 'segunda.jpg', { type: 'image/jpeg' }));
        document.querySelector('main label.drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, b64);
      await page.waitForFunction(() => /primera/.test(document.querySelector('[data-role="chosen"]').textContent));
      f = await cutoutFacts(page);
      t.equal(f.chosen, fill(s.chosen, { name: 'primera.jpg', width: 960, height: 640 }), 'a dropped image is chosen');
      t.equal(f.status, fill(s['chosen.first'], { count: 2 }), 'one image at a time, and the page says so');
      t.equal(t.hubTotal(), 0, 'nothing was downloaded');
      await t.noCsp(page);
      t.noPageErrors();
    },
  },
  {
    name: 'cutout: cancel stops the download from the page, and the next press resumes it and works',
    sites: ['cutout'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const s = t.strings[site.site].es;
      const page = await t.open(ctx, site, '/');
      const m = t.registry.models[site.models[0]];
      const { url: weight, size } = variantFiles(m, chooseVariant(m, 'auto', t.probe).variant).find(x => /\.onnx$/.test(x.path));
      await page.setInputFiles('main label.drop input[type="file"]', join(FIX, 'foto.jpg'));
      await page.waitForFunction(() => !document.querySelector('[data-role="preview"]').hidden);
      // Press Cancel from the page as soon as a fifth of the model has arrived.
      await page.evaluate(() => {
        const bar = document.querySelector('main progress');
        const cancel = document.querySelector('[data-action="cancel"]');
        new MutationObserver(() => {
          if (!globalThis.__cancelledAt && bar.max > 1 && bar.value / bar.max >= 0.2) { globalThis.__cancelledAt = bar.value; cancel.click(); }
        }).observe(bar, { attributes: true });
      });
      const f0 = await cutoutFacts(page);
      t.equal(f0.cancelHidden, true, 'cancel is hidden while nothing runs');
      await page.click('main button.primary');
      await page.waitForFunction(text => document.querySelector('main p.status').textContent === text, s['error.aborted'], { timeout: RUN_TIMEOUT });
      await page.waitForTimeout(1500);
      const sent = t.hub.served.get(weight) || 0;
      t.ok(sent < size, `the download stopped before the end (${Math.round((100 * sent) / size)}% sent)`);
      let f = await cutoutFacts(page);
      t.equal([f.cancelHidden, f.primary.disabled, f.cards], [true, false, 0], 'cancel hides, the button is back, no result');
      t.hub.reset();
      await pressAndWait(page);
      f = await cutoutFacts(page);
      t.ok(f.diag?.cutout?.runs === 1, `the next press works: ${JSON.stringify({ status: f.status, errors: f.diag?.errors })}`);
      t.ok(t.hub.counts.ranged.length > 0 || (t.hub.served.get(weight) || 0) < size, 'it resumed from what was stored');
      t.noPageErrors();
    },
  },
  {
    name: 'cutout: a failure inside the runtime is shown, the next press works in a new Worker; rotated and very large images',
    sites: ['cutout'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const s = t.strings[site.site].es;
      const input = 'main label.drop input[type="file"]';
      const page = await t.open(ctx, site, '/?test-fail=run');
      await page.setInputFiles(input, join(FIX, 'foto.jpg'));
      await page.waitForFunction(() => !document.querySelector('[data-role="preview"]').hidden);
      await pressAndWait(page);
      let f = await cutoutFacts(page);
      t.equal([f.status, f.diag?.errors?.at(-1), f.cards], [s['error.run-failed'], 'run-failed', 0], 'the first press fails on purpose, and says so');
      t.equal(f.primary.disabled, false, 'the button is back');
      await pressAndWait(page);
      f = await cutoutFacts(page);
      t.ok(f.diag?.cutout?.runs === 1 && f.cards === 1, `the second press works: ${JSON.stringify({ status: f.status, errors: f.diag?.errors })}`);
      t.equal(t.hub.counts.full.length, t.hubFull().length, 'the new Worker read the model from the store, not the Hub');

      // A photo whose Exif says to turn it: the page and the PNG follow the orientation.
      await page.setInputFiles(input, { name: 'girada.jpg', mimeType: 'image/jpeg', buffer: withOrientation(photo()) });
      await page.waitForFunction(() => /girada/.test(document.querySelector('[data-role="chosen"]').textContent));
      f = await cutoutFacts(page);
      t.equal(f.chosen, fill(s.chosen, { name: 'girada.jpg', width: 640, height: 960 }), 'the chosen image is shown upright');
      await pressAndWait(page);
      f = await cutoutFacts(page);
      t.equal([f.diag?.cutout?.runs, f.diag?.cutout?.width, f.diag?.cutout?.height], [2, 640, 960], 'the PNG is upright too');
      t.ok(f.diag?.cutout?.coverage > 0.15, `and the dog is still found (coverage ${f.diag?.cutout?.coverage})`);

      // An image longer than MAX_SIDE is reduced first, and the card says so.
      const wide = encodeGreyPng(9000, 40, new Uint8Array(9000 * 40).fill(128));
      await page.setInputFiles(input, { name: 'ancha.png', mimeType: 'image/png', buffer: wide });
      await page.waitForFunction(() => /ancha/.test(document.querySelector('[data-role="chosen"]').textContent));
      await pressAndWait(page);
      f = await cutoutFacts(page);
      t.equal([f.diag?.cutout?.runs, f.diag?.cutout?.width, f.diag?.cutout?.height, f.diag?.cutout?.scaled], [3, 4096, 18, true], 'scaled to 4096 px on its long side');
      t.ok(f.notes.includes(fill(s['result.scaled'], { width: 4096, height: 18 })), `the card says it was reduced: ${JSON.stringify(f.notes)}`);

      // A picture of 20000 × 20000 px in a file of a few kilobytes: refused from its header.
      const before = await page.evaluate(() => globalThis.__elffuss.errors.length);
      await page.setInputFiles(input, { name: 'enorme.png', mimeType: 'image/png', buffer: hugePng(20000, 20000) });
      await page.waitForFunction(n => globalThis.__elffuss.errors.length > n, before, { timeout: 30000 });
      f = await cutoutFacts(page);
      t.equal([f.status, f.primary.disabled, f.previewHidden], [s['error.too-large'], true, true], 'a picture over the pixel budget is refused before it is decoded');
      t.noPageErrors();
    },
  },
  {
    // A browser that caps WebAssembly below the heap BEN2 needs (here 3 GiB, by a
    // V8 flag): the page says so when the button is pressed, before the download.
    name: 'cutout: where WebAssembly cannot grow enough, out-of-memory before anything is downloaded',
    sites: ['cutout'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext({ args: ['--js-flags=--wasm-max-mem-pages=49152'] });
      const s = t.strings[site.site].es;
      const page = await t.open(ctx, site, '/');
      await page.setInputFiles('main label.drop input[type="file"]', join(FIX, 'foto.jpg'));
      await page.waitForFunction(() => !document.querySelector('[data-role="preview"]').hidden && !document.querySelector('main button.primary').disabled);
      await pressAndWait(page);
      const f = await cutoutFacts(page);
      t.equal([f.status, f.diag?.errors?.at(-1), f.cards], [s['error.out-of-memory'], 'out-of-memory', 0], 'the page says the browser cannot give the model what it needs');
      t.equal(t.hubTotal(), 0, 'and nothing was downloaded');
      t.noPageErrors();
    },
  },
  {
    name: 'cutout canary: BEN2 on WebGPU with the pinned ONNX Runtime still fails at its first run',
    sites: ['cutout'],
    configs: ['A'],
    async run(t, site) {
      // The cutout build ships the WebAssembly-only runtime. A site whose model declares
      // WebGPU ships the WebGPU one, and every test build has the core's generic smoke
      // Worker: run BEN2 there, declared on WebGPU in a copy of the registry, to learn
      // when an ONNX Runtime upgrade fixes it.
      const host = t.sites.find(x => !x.catalog && x.models.some(id => t.registry.models[id]?.devices?.webgpu));
      if (!host) { t.note('no site ships the WebGPU runtime: canary not run'); return; }
      const ctx = await t.newContext();
      const page = await t.open(ctx, host, '/licencias/', { wait: 'load' });
      const r = await page.evaluate(async ([modelId, limit]) => {
        const base = document.querySelector('link[rel="stylesheet"]').getAttribute('href').replace(/shared\/tokens\.css$/, '');
        const { Task } = await import(base + 'sdk/core/task.js');
        const { loadRegistry } = await import(base + 'sdk/core/registry.js');
        const { createStoreClient } = await import(base + 'sdk/core/store-client.js');
        const config = (await import(base + 'config.js')).default;
        const registry = structuredClone(await loadRegistry());
        const m = registry.models[modelId];
        m.devices = { webgpu: m.devices.wasm };
        const errors = [];
        const task = new Task({ task: null, workerUrl: new URL(base + '__test__/smoke-worker.js', location.href), impl: null },
          { device: 'webgpu', model: modelId, registry, store: createStoreClient({ url: config.storeUrl }), runtime: config.runtime });
        const img = await createImageBitmap(new ImageData(new Uint8ClampedArray(64 * 64 * 4).fill(160), 64, 64));
        // A shader error may also leave a run without an answer: that counts as failing too.
        const bounded = p => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error('no answer within the limit'), { code: 'timeout' })), limit))]);
        let info = null;
        try {
          info = await bounded(task.load());
          const value = await bounded(task.run(img));
          return { stage: 'ran', info, value };
        } catch (e) {
          errors.push({ code: e.code, message: String(e.message || e).slice(0, 500) });
          return { stage: info ? 'run' : 'load', info, errors };
        } finally {
          // dispose() waits for the run in progress, which may never end: do not wait for it.
          const released = task.dispose().catch(() => {});
          if (!errors.some(x => x.code === 'timeout')) await released;
        }
      }, [site.models[0], RUN_TIMEOUT / 2]);
      t.note(`BEN2 on WebGPU: ${r.stage === 'ran' ? 'ran' : `failed at ${r.stage}: ${r.errors?.[0]?.message?.slice(0, 160)}`}`);
      if (r.stage === 'ran') {
        t.ok(false, 'BEN2 now runs on WebGPU with the pinned ONNX Runtime: check its mask against the WebAssembly reference and declare WebGPU in registry/source.mjs');
        return;
      }
      t.equal(r.info?.device, 'webgpu', 'the session was created on WebGPU (the premise of the canary)');
      t.equal(r.stage, 'run', 'it fails at its first run, not at loading');
      // The canary records the error it gets; it does not claim a cause (runonweb saw
      // the fused LayerNorm; our runs have seen a WebGPU buffer allocation fail).
      const err = r.errors?.[0];
      t.ok(err && (isShaderError(new Error(err.message)) || err.code === 'timeout'), `with a failure inside ONNX Runtime's WebGPU run (or no answer): ${err?.message}`);
      t.note(`where: ${/LayerNorm/i.test(err?.message || '') ? 'LayerNorm' : /buffer_manager|buffer/i.test(err?.message || '') ? 'a WebGPU buffer allocation' : 'not named in the message'}`);
    },
  },
];
