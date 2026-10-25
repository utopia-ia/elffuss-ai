// SPDX-License-Identifier: Apache-2.0 AND MIT
// Copyright (c) 2026 UtopiaIA
// Portions Copyright (c) 2026 Miguel Ángel Durán (runonweb.ai, MIT; see LICENSES/MIT-runonweb.txt):
//   the per-class sigmoid decoding with the threshold compared in logit space, the
//   corner conversion of the boxes and the sparse label list
//   (packages/runonweb/src/detect/index.ts:155-299), adapted in decodeDetections,
//   logitOf and labelList.
//
// Decoding the raw outputs of RF-DETR. The model scores every class of every query
// with its own sigmoid: there is no softmax and no "no object" class. The generic
// DETR post-processing of Transformers.js drops the last class as background and
// uses a softmax, which gives wrong scores for this model, so its outputs are
// decoded here. Pure functions: no runtime, no DOM.

import { AiError } from '../core/errors.js';

/** Default minimum score of a detection. */
export const DEFAULT_THRESHOLD = 0.5;

/**
 * @typedef {{ xmin: number, ymin: number, xmax: number, ymax: number }} DetectBox
 *   Corners in pixels of the image as it was decoded (EXIF orientation applied).
 * @typedef {{ label: string, score: number, box: DetectBox }} DetectedObject
 *   `label` is the model's class name, in English; `score` goes from 0 to 1.
 * @typedef {{ dims: number[], data: ArrayLike<number> }} RawTensor
 */
const BOX_KEYS = Object.freeze(['xmin', 'ymin', 'xmax', 'ymax']);

/** The logistic function. */
export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * The logit whose sigmoid is `p`: comparing raw logits with it gives the same
 * answer as comparing scores with `p`, without a sigmoid per class.
 * @param {number} p
 */
export function logitOf(p) {
  if (!(p > 0)) return -Infinity;
  if (p >= 1) return Infinity;
  return -Math.log(1 / p - 1);
}

/**
 * A usable threshold: a number between 0 and 1, or the default.
 * @param {unknown} t
 */
export function clampThreshold(t) {
  const n = typeof t === 'number' ? t : typeof t === 'string' && t.trim() ? Number(t) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.min(1, Math.max(0, n));
}

/**
 * Class names by class index. `id2label` maps ids (as strings) to names; ids may
 * be sparse (COCO numbers its 80 classes from 1 to 90), so the list has a hole
 * wherever the model has a class without a name.
 * @param {Record<string, string>} id2label
 * @param {number} numClasses
 * @returns {(string|undefined)[]}
 */
export function labelList(id2label, numClasses) {
  const out = new Array(Math.max(0, numClasses | 0)).fill(undefined);
  for (const [id, name] of Object.entries(id2label || {})) {
    const i = Number(id);
    if (Number.isInteger(i) && i >= 0 && i < out.length && typeof name === 'string' && name) out[i] = name;
  }
  return out;
}

/** Queries and classes of a logits tensor shaped [1, queries, classes] or [queries, classes]. */
export function logitShape(dims) {
  if (dims?.length === 3 && dims[0] === 1) return { queries: dims[1], classes: dims[2] };
  if (dims?.length === 2) return { queries: dims[0], classes: dims[1] };
  throw new AiError('model-mismatch', `unexpected logits shape [${dims}]`, { details: { dims } });
}

/**
 * Box of one query in pixels: the model gives the centre, width and height as
 * fractions of the image; the corners are clamped to the image.
 * @returns {DetectBox|null} null when the box is empty or not a number
 */
export function cornerBox(cx, cy, w, h, width, height) {
  const box = {
    xmin: Math.min(width, Math.max(0, (cx - w / 2) * width)),
    ymin: Math.min(height, Math.max(0, (cy - h / 2) * height)),
    xmax: Math.min(width, Math.max(0, (cx + w / 2) * width)),
    ymax: Math.min(height, Math.max(0, (cy + h / 2) * height)),
  };
  if (!BOX_KEYS.every(k => Number.isFinite(box[k]))) return null;
  if (!(box.xmax > box.xmin && box.ymax > box.ymin)) return null;
  return box;
}

/**
 * Objects found by RF-DETR, from its raw outputs.
 * For each query, the best class that has a name; kept when its score reaches
 * the threshold. Sorted by score, highest first.
 * @param {{ logits: RawTensor, boxes: RawTensor, labels: (string|undefined)[], threshold?: number, width: number, height: number }} o
 *   `boxes` is shaped [1, queries, 4] (centre x, centre y, width, height, as fractions);
 *   `width` and `height` are the size of the image the boxes are given in.
 * @returns {DetectedObject[]}
 */
export function decodeDetections({ logits, boxes, labels, threshold = DEFAULT_THRESHOLD, width, height }) {
  const { queries, classes } = logitShape(logits.dims);
  if (labels.length !== classes) throw new AiError('model-mismatch', `${classes} classes, ${labels.length} labels`);
  const named = [];
  for (let k = 0; k < classes; k++) if (labels[k]) named.push(k);
  if (!named.length) throw new AiError('model-mismatch', 'no class of the model has a name');
  const bd = boxes.dims;
  if (!(bd?.length >= 2 && bd[bd.length - 1] === 4 && bd[bd.length - 2] === queries)) {
    throw new AiError('model-mismatch', `unexpected boxes shape [${bd}]`, { details: { dims: bd } });
  }
  if (!(width > 0 && height > 0)) throw new AiError('run-failed', 'the image has no size');
  const t = clampThreshold(threshold);
  const cut = logitOf(t);
  const L = logits.data, B = boxes.data;
  const out = [];
  for (let q = 0; q < queries; q++) {
    const base = q * classes;
    let best = -Infinity, bestK = -1;
    for (const k of named) {
      const v = L[base + k];
      if (v > best) { best = v; bestK = k; }
    }
    if (bestK < 0 || best < cut) continue;
    const score = sigmoid(best);
    if (score < t) continue;
    const b = q * 4;
    const box = cornerBox(B[b], B[b + 1], B[b + 2], B[b + 3], width, height);
    if (box) out.push({ label: labels[bestK], score, box });
  }
  return out.sort((a, b) => b.score - a.score);
}
