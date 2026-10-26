// SPDX-License-Identifier: Apache-2.0 AND MIT-CMU
// Copyright (c) 2026 UtopiaIA
// resampleWeights() is adapted from Pillow (src/libImaging/Resample.c,
// precompute_coeffs), MIT-CMU License, see LICENSES/MIT-CMU-Pillow.txt:
//   Copyright © 1997-2011 by Secret Labs AB
//   Copyright © 1995-2011 by Fredrik Lundh and contributors
//   Copyright © 2010 by Jeffrey A. Clark and contributors
//
// The image maths of background removal, with no browser API so that Node tests
// them: the model input (the photo resized to the model's square with Pillow's
// bilinear filter, which averages every pixel when it shrinks instead of
// sampling a few, then normalised as the model's preprocessor config says), the
// mask brought back to the photo's size, and the alpha put on the photo's pixels.
// The same numbers come out on every browser and backend: nothing here goes
// through a canvas.

import { AiError } from '../core/errors.js';

/**
 * Largest side the task processes; a larger image is scaled down to it first,
 * and the result says so. It keeps the full size of the photos of most cameras
 * and bounds what one run holds: the output PNG, its mask and the photo.
 */
export const MAX_SIDE = 4096;

/**
 * Coefficients of a one-dimensional resampling with Pillow's bilinear filter: a
 * triangle one pixel wide when enlarging (plain bilinear, pixel centres at
 * half-integers, as `align_corners=False`) and as wide as the scale when
 * shrinking, so that every input pixel counts. Each row sums to 1. Adapted from
 * Pillow's precompute_coeffs (MIT-CMU; see the top of this file).
 * @param {number} inSize
 * @param {number} outSize
 * @returns {{ start: Int32Array, count: Int32Array, weights: Float32Array, ksize: number }}
 */
export function resampleWeights(inSize, outSize) {
  if (!(Number.isInteger(inSize) && inSize > 0 && Number.isInteger(outSize) && outSize > 0)) throw new RangeError('sizes must be positive integers');
  const scale = inSize / outSize;
  const filterscale = Math.max(1, scale);
  const support = filterscale; // the bilinear filter's support is 1
  const ksize = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const weights = new Float32Array(outSize * ksize);
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    const lo = Math.max(0, Math.trunc(center - support + 0.5));
    const hi = Math.min(inSize, Math.trunc(center + support + 0.5));
    const n = Math.min(ksize, hi - lo);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.abs((i + lo - center + 0.5) / filterscale);
      const w = t < 1 ? 1 - t : 0;
      weights[o * ksize + i] = w;
      sum += w;
    }
    if (sum > 0) for (let i = 0; i < n; i++) weights[o * ksize + i] /= sum;
    start[o] = lo;
    count[o] = n;
  }
  return { start, count, weights, ksize };
}

/** Horizontal pass of one channel of an interleaved image into `tmp` (h rows of ow). */
function horizontalPass(src, w, h, stride, offset, ow, H, tmp) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < ow; x++) {
      const s = H.start[x], n = H.count[x], k = x * H.ksize;
      let acc = 0;
      for (let i = 0; i < n; i++) acc += src[(row + s + i) * stride + offset] * H.weights[k + i];
      tmp[y * ow + x] = acc;
    }
  }
  return tmp;
}

/** Vertical pass for output row `y`, from the horizontal pass `tmp`, into `row` (ow values). */
function verticalRow(tmp, ow, V, y, row) {
  row.fill(0);
  const s = V.start[y], n = V.count[y], k = y * V.ksize;
  for (let i = 0; i < n; i++) {
    const wgt = V.weights[k + i], r = (s + i) * ow;
    for (let x = 0; x < ow; x++) row[x] += tmp[r + x] * wgt;
  }
  return row;
}

/** Resample one channel of an interleaved image into the plane `out` (oh × ow). */
function resampleChannel(src, w, h, stride, offset, ow, oh, H, V, tmp, out) {
  horizontalPass(src, w, h, stride, offset, ow, H, tmp);
  for (let y = 0; y < oh; y++) verticalRow(tmp, ow, V, y, out.subarray(y * ow, (y + 1) * ow));
  return out;
}

/**
 * Resample a single-channel plane (any numeric array) to another size.
 * @param {ArrayLike<number>} src
 * @param {number} w
 * @param {number} h
 * @param {number} ow
 * @param {number} oh
 * @returns {Float32Array}
 */
export function resamplePlane(src, w, h, ow, oh) {
  if (src.length !== w * h) throw new RangeError(`a ${w}×${h} plane needs ${w * h} values, not ${src.length}`);
  return resampleChannel(src, w, h, 1, 0, ow, oh, resampleWeights(w, ow), resampleWeights(h, oh), new Float32Array(h * ow), new Float32Array(ow * oh));
}

const isNum = x => typeof x === 'number' && Number.isFinite(x);

/**
 * What the model takes, read from its image processor (Transformers.js reads it
 * from preprocessor_config.json): the square size, and the rescale and
 * normalisation it was trained with.
 * @param {{ size?: { width?: number, height?: number }|number, image_mean?: number[]|number, image_std?: number[]|number,
 *   rescale_factor?: number, do_rescale?: boolean, do_normalize?: boolean, do_resize?: boolean }} processor
 * @returns {{ width: number, height: number, mean: number[], std: number[], rescale: number }}
 */
export function inputSpec(processor) {
  const p = processor || {};
  const size = typeof p.size === 'number' ? { width: p.size, height: p.size } : p.size || {};
  const ok = v => Number.isInteger(v) && v >= 32 && v <= 4096;
  if (p.do_resize === false || !ok(size.width) || !ok(size.height)) throw new AiError('model-mismatch', 'the model does not declare a fixed input size', { details: { size: p.size } });
  const three = v => (Array.isArray(v) ? v : [v, v, v]);
  const mean = p.do_normalize === false ? [0, 0, 0] : three(p.image_mean);
  const std = p.do_normalize === false ? [1, 1, 1] : three(p.image_std);
  if (mean.length !== 3 || std.length !== 3 || !mean.every(isNum) || !std.every(x => isNum(x) && x > 0)) {
    throw new AiError('model-mismatch', 'the model does not declare three channel means and deviations', { details: { mean: p.image_mean, std: p.image_std } });
  }
  const rescale = p.do_rescale === false ? 1 : p.rescale_factor ?? 1 / 255;
  if (!isNum(rescale) || rescale <= 0) throw new AiError('model-mismatch', 'bad rescale factor', { details: { rescale } });
  return { width: size.width, height: size.height, mean, std, rescale };
}

/**
 * The model input: RGBA pixels resized to the model's size and normalised, as
 * a planar (channels first) Float32Array: (value · rescale − mean) / std.
 * The alpha the image may have is not read: the model sees the colours.
 * @param {{ data: ArrayLike<number>, width: number, height: number }} img RGBA, 8 bits per channel
 * @param {{ width: number, height: number, mean: number[], std: number[], rescale: number }} spec
 * @returns {Float32Array} 3 × spec.height × spec.width values
 */
export function toModelInput({ data, width, height }, { width: W, height: H, mean, std, rescale }) {
  if (data.length !== width * height * 4) throw new RangeError(`RGBA ${width}×${height} needs ${width * height * 4} bytes, not ${data.length}`);
  const Hw = resampleWeights(width, W), Vw = resampleWeights(height, H);
  const tmp = new Float32Array(height * W);
  const out = new Float32Array(3 * W * H);
  for (let c = 0; c < 3; c++) {
    const plane = out.subarray(c * W * H, (c + 1) * W * H);
    resampleChannel(data, width, height, 4, c, W, H, Hw, Vw, tmp, plane);
    const m = mean[c], s = std[c];
    for (let i = 0; i < plane.length; i++) plane[i] = (plane[i] * rescale - m) / s;
  }
  return out;
}

/**
 * The model's output, at the image's size, as alpha (0-255). Values outside
 * 0-1 are taken as logits and pass through a sigmoid first, as the
 * Transformers.js segmentation pipeline does; anything that is not a number
 * means the run went wrong.
 * @param {ArrayLike<number>} mask mw × mh values
 * @param {number} mw
 * @param {number} mh
 * @param {number} ow
 * @param {number} oh
 * @returns {Uint8Array}
 */
export function maskToAlpha(mask, mw, mh, ow, oh) {
  if (mask.length !== mw * mh) throw new AiError('model-mismatch', `the mask has ${mask.length} values, not ${mw}×${mh}`);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i];
    if (!Number.isFinite(v)) throw new AiError('run-failed', 'the model gave a mask with values that are not numbers');
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const logits = lo < -1e-5 || hi > 1 + 1e-5;
  const src = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    const v = logits ? 1 / (1 + Math.exp(-mask[i])) : mask[i];
    src[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  // Row by row into bytes: a large photo never holds a float copy of its whole alpha.
  const V = resampleWeights(mh, oh);
  const tmp = horizontalPass(src, mw, mh, 1, 0, ow, resampleWeights(mw, ow), new Float32Array(mh * ow));
  const row = new Float32Array(ow);
  const alpha = new Uint8Array(ow * oh);
  for (let y = 0; y < oh; y++) {
    verticalRow(tmp, ow, V, y, row);
    for (let x = 0, o = y * ow; x < ow; x++) {
      const v = row[x];
      alpha[o + x] = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
    }
  }
  return alpha;
}

/**
 * Put the mask on RGBA pixels, in place. Where the image already had some
 * transparency it stays: the result is mask × the image's own alpha. `alpha`
 * is updated to what the pixels end up with, so it is the PNG's alpha channel.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {Uint8Array} alpha
 * @returns {Uint8ClampedArray|Uint8Array} rgba
 */
export function applyAlpha(rgba, alpha) {
  if (rgba.length !== alpha.length * 4) throw new RangeError('the mask and the image do not have the same size');
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) {
    const own = rgba[j];
    const a = own === 255 ? alpha[i] : Math.round((alpha[i] * own) / 255);
    alpha[i] = a;
    rgba[j] = a;
  }
  return rgba;
}

/**
 * Share of the pixels the cut keeps (alpha at least `threshold`), from 0 to 1.
 * @param {Uint8Array} alpha
 * @param {number} [threshold]
 */
export function coverage(alpha, threshold = 128) {
  if (!alpha.length) return 0;
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= threshold) n++;
  return n / alpha.length;
}

/**
 * The longest side the task decodes at: the caller's `maxSide` when it is a
 * positive integer below MAX_SIDE, else MAX_SIDE.
 * @param {unknown} maxSide
 */
export function sideLimit(maxSide) {
  const n = Number(maxSide);
  return Number.isInteger(n) && n >= 16 && n < MAX_SIDE ? n : MAX_SIDE;
}
