// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Text recognition around the PP-OCR CTC recogniser: strips are grouped by
// shape into batches, each strip is resized to the model's height keeping its
// shape (padded on the right up to the batch width, at least 320 at height
// 48), normalised to [−1, 1] in BGR order, and the output classes are read
// with greedy CTC decoding: the best class at each step, repeats merged,
// blanks dropped, and the mean probability of what is kept as the score. This
// follows the recognition pre-processing and CTCLabelDecode of PaddleOCR
// (https://github.com/PaddlePaddle/PaddleOCR, Apache-2.0).

/**
 * Width of a batch: the model's base width, or wider for the widest strip of
 * the batch, never more than `maxWidth`.
 * @param {{ width: number, height: number }[]} strips
 * @param {{ height: number, width: number, maxWidth: number }} cfg
 */
export function batchWidth(strips, { height, width, maxWidth }) {
  let ratio = width / height;
  for (const s of strips) ratio = Math.max(ratio, s.width / s.height);
  return Math.min(maxWidth, Math.trunc(height * ratio));
}

/** Width a strip takes inside a batch of width `imgW`. */
export function stripWidth(strip, imgW, height) {
  const w = Math.ceil(height * (strip.width / strip.height));
  return Math.max(1, Math.min(imgW, w));
}

/**
 * Batches of strip indices, narrowest shape first, bounded in count and in
 * total output steps (each step is a row of every class of the model).
 * @param {{ width: number, height: number }[]} strips
 * @param {{ height: number, width: number, maxWidth: number }} cfg
 * @param {{ maxBatch?: number, maxSteps?: number }} [limits]
 * @returns {number[][]}
 */
export function planBatches(strips, cfg, { maxBatch = 6, maxSteps = 640 } = {}) {
  const order = strips.map((s, i) => i).sort((a, b) => strips[a].width / strips[a].height - strips[b].width / strips[b].height || a - b);
  const batches = [];
  let cur = [];
  for (const i of order) {
    const next = [...cur, i];
    const steps = next.length * Math.ceil(batchWidth(next.map(k => strips[k]), cfg) / 8);
    if (cur.length && (next.length > maxBatch || steps > maxSteps)) { batches.push(cur); cur = [i]; }
    else cur = next;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * Write one strip into slot `b` of a batch tensor (B × 3 × height × imgW,
 * zero-filled): bilinear resize to `height` rows and its own width, rounded to
 * bytes like an 8-bit image, then (v / 255 − 0.5) / 0.5.
 * @param {Float32Array} tensor
 * @param {number} b
 * @param {number} imgW
 * @param {{ width: number, height: number, data: Uint8Array }} strip RGB
 * @param {{ height: number, bgr: boolean }} cfg
 */
export function writeStrip(tensor, b, imgW, strip, { height, bgr }) {
  const outW = stripWidth(strip, imgW, height);
  const { width: W, height: H, data } = strip;
  const plane = height * imgW;
  const base = b * 3 * plane;
  const sx = W / outW, sy = H / height;
  const src = bgr ? [2, 1, 0] : [0, 1, 2];
  for (let y = 0; y < height; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const j = Math.min(Math.floor(fy), H - 1), j1 = Math.min(j + 1, H - 1);
    const ty = Math.min(fy - j, 1);
    for (let x = 0; x < outW; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const i = Math.min(Math.floor(fx), W - 1), i1 = Math.min(i + 1, W - 1);
      const tx = Math.min(fx - i, 1);
      for (let c = 0; c < 3; c++) {
        const ch = src[c];
        const p = data[(j * W + i) * 3 + ch], q = data[(j * W + i1) * 3 + ch];
        const r = data[(j1 * W + i) * 3 + ch], t = data[(j1 * W + i1) * 3 + ch];
        const top = p + (q - p) * tx, bottom = r + (t - r) * tx;
        const v = Math.round(top + (bottom - top) * ty);
        tensor[base + c * plane + y * imgW + x] = (v / 255 - 0.5) / 0.5;
      }
    }
  }
  return outW;
}

/**
 * Greedy CTC decoding of a B × T × C block of class probabilities.
 * @param {Float32Array} probs
 * @param {number} B
 * @param {number} T
 * @param {number} C
 * @param {string[]} vocab index 0 is the blank
 * @returns {{ text: string, score: number }[]}
 */
export function ctcDecode(probs, B, T, C, vocab) {
  const out = [];
  for (let b = 0; b < B; b++) {
    let text = '', sum = 0, kept = 0, prev = -1;
    for (let t = 0; t < T; t++) {
      const o = (b * T + t) * C;
      let best = 0, bestP = probs[o];
      for (let c = 1; c < C; c++) { const p = probs[o + c]; if (p > bestP) { bestP = p; best = c; } }
      if (best !== 0 && best !== prev) { text += vocab[best] ?? ''; sum += bestP; kept++; }
      prev = best;
    }
    out.push({ text, score: kept ? sum / kept : 0 });
  }
  return out;
}
