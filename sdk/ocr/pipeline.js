// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The OCR of one page, from RGBA pixels to lines of text with their boxes:
// detect, post-process, crop, recognise in batches, decode, order. The two
// sessions come from outside (ONNX Runtime, any backend), so this module runs
// the same in a Worker, on a page or in Node.

import { AiError } from '../core/errors.js';
import { detInputSize, detTensor, dbPostprocess, filterBoxes } from './det.js';
import { cropQuad } from './crop.js';
import { planBatches, batchWidth, writeStrip, ctcDecode } from './rec.js';
import { boundingBox, cleanLine, pageText } from './order.js';
import { checkClasses } from './dict.js';

/**
 * @typedef {{ xmin: number, ymin: number, xmax: number, ymax: number }} Box
 * @typedef {{ text: string, score: number, box: Box, polygon: number[][] }} OcrLine
 * @typedef {{ det: any, rec: any, Tensor: any, cfg: { det: object, rec: object }, vocab: string[] }} OcrModels
 */

const tensorOf = (models, data, dims) => new models.Tensor('float32', data, dims);

async function runOne(session, feeds) {
  const out = await session.run(feeds);
  const t = out[session.outputNames[0]];
  if (!t) throw new AiError('model-mismatch', 'a model gave no output');
  const data = t.data instanceof Float32Array ? t.data : Float32Array.from(t.data);
  return { data, dims: t.dims, dispose: () => t.dispose?.() };
}

/**
 * Text boxes of a page, in its pixel coordinates.
 * @param {OcrModels} models
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img RGBA
 * @returns {Promise<{ points: number[][], score: number }[]>}
 */
export async function detect(models, img) {
  const cfg = models.cfg.det;
  const size = detInputSize(img.width, img.height, cfg);
  const input = detTensor(img, size.width, size.height, cfg);
  const out = await runOne(models.det, { [models.det.inputNames[0]]: tensorOf(models, input, [1, 3, size.height, size.width]) });
  try {
    const [n, c, h, w] = out.dims;
    if (n !== 1 || c !== 1 || h !== size.height || w !== size.width) throw new AiError('model-mismatch', `the detector gave a map of ${out.dims.join('×')} for an input of ${size.height}×${size.width}`);
    return filterBoxes(dbPostprocess(out.data, w, h, cfg, img.width, img.height), img.width, img.height);
  } finally {
    out.dispose();
  }
}

/**
 * Text of each strip, in the order given.
 * @param {OcrModels} models
 * @param {{ width: number, height: number, data: Uint8Array }[]} strips RGB
 * @returns {Promise<{ text: string, score: number }[]>}
 */
export async function recognize(models, strips, limits) {
  const cfg = models.cfg.rec;
  const results = new Array(strips.length);
  for (const batch of planBatches(strips, cfg, limits)) {
    const imgW = batchWidth(batch.map(i => strips[i]), cfg);
    const tensor = new Float32Array(batch.length * 3 * cfg.height * imgW);
    batch.forEach((i, b) => writeStrip(tensor, b, imgW, strips[i], cfg));
    const out = await runOne(models.rec, { [models.rec.inputNames[0]]: tensorOf(models, tensor, [batch.length, 3, cfg.height, imgW]) });
    try {
      const [B, T, C] = out.dims;
      if (B !== batch.length) throw new AiError('model-mismatch', `the recogniser gave ${B} results for ${batch.length} strips`);
      checkClasses(C, models.vocab);
      ctcDecode(out.data, B, T, C, models.vocab).forEach((r, b) => { results[batch[b]] = r; });
    } finally {
      out.dispose();
    }
  }
  return results;
}

/**
 * Recognised strips of one page as it is given, before any filtering: text,
 * score and the detector's polygon, in the image's pixels.
 * @param {OcrModels} models
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img RGBA
 * @returns {Promise<{ text: string, score: number, points: number[][] }[]>}
 */
async function readStrips(models, img, maxBatch) {
  const boxes = await detect(models, img);
  const strips = [], kept = [];
  for (const b of boxes) {
    const s = cropQuad(img, b.points);
    if (s) { strips.push(s); kept.push(b); }
  }
  const texts = strips.length ? await recognize(models, strips, { maxBatch }) : [];
  return texts.map((r, i) => ({ text: cleanLine(r.text), score: r.score, points: kept[i].points }));
}

/**
 * How a reading of a page looks: how many characters it read, its mean score
 * (weighted by characters), and the share of its boxes that stand upright
 * (at least 1.5 times taller than wide: lines of a page turned a quarter).
 * @param {{ text: string, score: number, points: number[][] }[]} strips
 */
export function readingStats(strips) {
  let chars = 0, weighted = 0, upright = 0, boxes = 0;
  for (const s of strips) {
    const b = boundingBox(s.points);
    boxes++;
    if (b.ymax - b.ymin >= 1.5 * (b.xmax - b.xmin)) upright++;
    const n = [...s.text].length;
    chars += n;
    weighted += n * s.score;
  }
  return { boxes, chars, meanScore: chars ? weighted / chars : 0, uprightShare: boxes ? upright / boxes : 0 };
}

/** Below this mean score a page with lying boxes is tried upside down too. */
export const LOW_SCORE = 0.8;
/** Share of upright boxes above which a page is taken to be turned a quarter. */
export const UPRIGHT_SHARE = 0.5;
/** How much better (mean score) another orientation must read to be kept. */
export const BETTER_BY = 0.05;

/**
 * Which orientations to try after reading a page as it is: a quarter turn
 * either way when most of its boxes stand upright, half a turn when its boxes
 * lie but read badly. Angles are clockwise, in degrees.
 * @param {ReturnType<typeof readingStats>} stats
 * @returns {number[]}
 */
export function orientationsToTry(stats) {
  if (!stats.boxes) return [];
  if (stats.uprightShare > UPRIGHT_SHARE) return [90, 270];
  if (stats.meanScore < LOW_SCORE) return [180];
  return [];
}

/**
 * Turn RGBA pixels clockwise by 90, 180 or 270 degrees.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img
 * @param {90|180|270} deg
 */
export function rotateRgba({ width: W, height: H, data }, deg) {
  const quarter = deg === 90 || deg === 270;
  const w = quarter ? H : W, h = quarter ? W : H;
  const out = new Uint8ClampedArray(w * h * 4);
  const src = new Uint32Array(data.buffer, data.byteOffset, W * H);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = src[y * W + x];
      if (deg === 90) dst[x * w + (H - 1 - y)] = v;
      else if (deg === 180) dst[(H - 1 - y) * w + (W - 1 - x)] = v;
      else dst[(W - 1 - x) * w + y] = v;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * A point of the turned image back in the pixels of the image as given
 * (`W` × `H`, before turning it `deg` degrees clockwise).
 * @param {number[]} p
 * @param {number} deg
 * @param {number} W
 * @param {number} H
 */
export function unturn([x, y], deg, W, H) {
  if (deg === 90) return [y, H - x];
  if (deg === 180) return [W - x, H - y];
  if (deg === 270) return [W - y, x];
  return [x, y];
}

/**
 * OCR of one page. A page that is turned (a scan fed sideways or upside down)
 * is detected from its first reading and read again turned upright; the result
 * says the angle (`orientation`, clockwise degrees it was turned to read it),
 * and the boxes are always in the pixels of the page as given.
 * @param {OcrModels} models
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img RGBA
 * @param {{ minScore?: number, scale?: number, maxBatch?: number, orient?: boolean }} [opts] `scale` multiplies
 *   every coordinate (to report boxes in the pixels of a larger original);
 *   `maxBatch` strips per recogniser run: 1 by default, so a line reads the same
 *   whatever else is on the page (a batch pads each strip to its widest one);
 *   `orient` false reads the page only as it is
 * @returns {Promise<{ text: string, lines: OcrLine[], orientation: 0|90|180|270, meanScore: number }>}
 */
export async function ocrPage(models, img, { minScore = 0.5, scale = 1, maxBatch = 1, orient = true } = {}) {
  let best = { deg: 0, strips: await readStrips(models, img, maxBatch) };
  best.stats = readingStats(best.strips);
  for (const deg of orient ? orientationsToTry(best.stats) : []) {
    const strips = await readStrips(models, rotateRgba(img, deg), maxBatch);
    const stats = readingStats(strips);
    // A quarter turn is taken when it reads at least as well (its lines are then
    // in their real order); half a turn only when it reads clearly better.
    const margin = best.deg === 0 && deg === 180 ? BETTER_BY : (best.deg === 0 ? -BETTER_BY : BETTER_BY);
    if (stats.chars && stats.meanScore > best.stats.meanScore + margin) best = { deg, strips, stats };
  }
  // Order the lines where they read upright, then put them back on the page as given.
  const lines = [];
  for (const r of best.strips) {
    if (!r.text || r.score < minScore) continue;
    lines.push({ text: r.text, score: Math.round(r.score * 1e4) / 1e4, box: boundingBox(r.points), points: r.points });
  }
  const page = pageText(lines);
  const out = page.lines.map(l => {
    const polygon = l.points.map(p => unturn(p, best.deg, img.width, img.height)).map(([x, y]) => [Math.round(x * scale), Math.round(y * scale)]);
    return { text: l.text, score: l.score, box: boundingBox(polygon), polygon };
  });
  return { text: page.text, lines: out, orientation: best.deg, meanScore: Math.round(best.stats.meanScore * 1e4) / 1e4 };
}
