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
 * OCR of one page.
 * @param {OcrModels} models
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img RGBA
 * @param {{ minScore?: number, scale?: number, maxBatch?: number }} [opts] `scale` multiplies
 *   every coordinate (to report boxes in the pixels of a larger original);
 *   `maxBatch` strips per recogniser run: 1 by default, so a line reads the same
 *   whatever else is on the page (a batch pads each strip to its widest one)
 * @returns {Promise<{ text: string, lines: OcrLine[] }>}
 */
export async function ocrPage(models, img, { minScore = 0.5, scale = 1, maxBatch = 1 } = {}) {
  const boxes = await detect(models, img);
  const strips = [], kept = [];
  for (const b of boxes) {
    const s = cropQuad(img, b.points);
    if (s) { strips.push(s); kept.push(b); }
  }
  const texts = strips.length ? await recognize(models, strips, { maxBatch }) : [];
  const lines = [];
  texts.forEach((r, i) => {
    const text = cleanLine(r.text);
    if (!text || r.score < minScore) return;
    const polygon = kept[i].points.map(([x, y]) => [Math.round(x * scale), Math.round(y * scale)]);
    lines.push({ text, score: Math.round(r.score * 1e4) / 1e4, box: boundingBox(polygon), polygon });
  });
  return pageText(lines);
}
