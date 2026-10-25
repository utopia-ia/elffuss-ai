// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Text detection around the PP-OCR DB detector: the resize of the input (sides
// in multiples of 32, the shortest brought up to a minimum, the longest kept
// under the model's limit), the normalised BGR tensor, and the post-processing
// of its probability map into quadrilaterals. The post-processing follows the
// DB post-processing of PaddleOCR (https://github.com/PaddlePaddle/PaddleOCR,
// Apache-2.0): threshold, connected regions, minimum-area rectangle, mean
// probability inside it, expansion by area × ratio / perimeter, and scaling
// back to the image. Everything here is plain arithmetic on typed arrays.

/**
 * Size of the detector input for an image.
 * @param {number} width
 * @param {number} height
 * @param {{ limitSideLen: number, maxSideLimit: number, multiple: number }} cfg
 * @returns {{ width: number, height: number }}
 */
export function detInputSize(width, height, { limitSideLen, maxSideLimit, multiple }) {
  let ratio = Math.min(width, height) < limitSideLen ? limitSideLen / Math.min(width, height) : 1;
  let w = Math.trunc(width * ratio), h = Math.trunc(height * ratio);
  if (Math.max(w, h) > maxSideLimit) {
    ratio = maxSideLimit / Math.max(w, h);
    w = Math.trunc(w * ratio);
    h = Math.trunc(h * ratio);
  }
  const round = v => Math.max(Math.round(v / multiple) * multiple, multiple);
  return { width: round(w), height: round(h) };
}

/**
 * Bilinear resample of RGBA pixels (pixel centres aligned, edges clamped), one
 * channel at a time into a planar float tensor, normalised per channel.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img RGBA
 * @param {number} outW
 * @param {number} outH
 * @param {{ mean: readonly number[], std: readonly number[], scale: number, bgr: boolean }} norm
 * @returns {Float32Array} 3 × outH × outW, channel order B, G, R when `bgr`
 */
export function detTensor(img, outW, outH, { mean, std, scale, bgr }) {
  const { width: W, height: H, data } = img;
  const plane = outW * outH;
  const out = new Float32Array(3 * plane);
  const sx = W / outW, sy = H / outH;
  const x0 = new Int32Array(outW), x1 = new Int32Array(outW), fx = new Float32Array(outW);
  for (let x = 0; x < outW; x++) {
    let s = (x + 0.5) * sx - 0.5;
    if (s < 0) s = 0;
    const i = Math.min(Math.floor(s), W - 1);
    x0[x] = i * 4; x1[x] = Math.min(i + 1, W - 1) * 4; fx[x] = Math.min(s - i, 1);
  }
  // Channel c of the tensor reads RGBA channel src[c].
  const src = bgr ? [2, 1, 0] : [0, 1, 2];
  const mul = [0, 1, 2].map(c => scale / std[c]);
  const add = [0, 1, 2].map(c => -mean[c] / std[c]);
  for (let y = 0; y < outH; y++) {
    let s = (y + 0.5) * sy - 0.5;
    if (s < 0) s = 0;
    const j = Math.min(Math.floor(s), H - 1);
    const r0 = j * W * 4, r1 = Math.min(j + 1, H - 1) * W * 4, fy = Math.min(s - j, 1);
    const o = y * outW;
    for (let c = 0; c < 3; c++) {
      const ch = src[c], m = mul[c], a = add[c], base = c * plane + o;
      for (let x = 0; x < outW; x++) {
        const p = data[r0 + x0[x] + ch], q = data[r0 + x1[x] + ch];
        const r = data[r1 + x0[x] + ch], t = data[r1 + x1[x] + ch];
        const top = p + (q - p) * fx[x], bottom = r + (t - r) * fx[x];
        out[base + x] = (top + (bottom - top) * fy) * m + a;
      }
    }
  }
  return out;
}

/**
 * Connected regions (8-connected) of the pixels above `thresh`, by runs.
 * Each region comes with the end points of its runs (enough for its convex
 * hull) and its bounding box, in raster order of their first pixel.
 * @param {Float32Array} prob height × width
 * @returns {{ points: Int32Array, count: number, xmin: number, ymin: number, xmax: number, ymax: number }[]}
 */
export function regions(prob, width, height, thresh) {
  const ry = [], rx0 = [], rx1 = [];
  const parent = [];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
  let prevStart = 0, prevEnd = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = ry.length;
    const o = y * width;
    for (let x = 0; x < width; x++) {
      if (!(prob[o + x] > thresh)) continue;
      const s = x;
      while (x + 1 < width && prob[o + x + 1] > thresh) x++;
      const id = ry.length;
      ry.push(y); rx0.push(s); rx1.push(x); parent.push(id);
    }
    const rowEnd = ry.length;
    // Join with the runs of the row above that touch, diagonals included.
    let p = prevStart;
    for (let r = rowStart; r < rowEnd; r++) {
      while (p < prevEnd && rx1[p] < rx0[r] - 1) p++;
      for (let q = p; q < prevEnd && rx0[q] <= rx1[r] + 1; q++) union(r, q);
    }
    prevStart = rowStart; prevEnd = rowEnd;
  }
  const byRoot = new Map();
  for (let r = 0; r < ry.length; r++) {
    const root = find(r);
    let g = byRoot.get(root);
    if (!g) { g = { runs: [], xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity }; byRoot.set(root, g); }
    g.runs.push(r);
    if (rx0[r] < g.xmin) g.xmin = rx0[r];
    if (rx1[r] > g.xmax) g.xmax = rx1[r];
    if (ry[r] < g.ymin) g.ymin = ry[r];
    if (ry[r] > g.ymax) g.ymax = ry[r];
  }
  const out = [];
  for (const g of byRoot.values()) {
    const pts = new Int32Array(g.runs.length * 4);
    let k = 0;
    for (const r of g.runs) { pts[k++] = rx0[r]; pts[k++] = ry[r]; pts[k++] = rx1[r]; pts[k++] = ry[r]; }
    out.push({ points: pts, count: g.runs.length * 2, xmin: g.xmin, ymin: g.ymin, xmax: g.xmax, ymax: g.ymax });
  }
  return out;
}

/**
 * Convex hull (monotone chain) of points given as [x0, y0, x1, y1, …].
 * @returns {number[][]} counter-clockwise in image coordinates, no repeated end
 */
export function convexHull(flat, count = flat.length / 2) {
  const pts = [];
  for (let i = 0; i < count; i++) pts.push([flat[2 * i], flat[2 * i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  if (uniq.length <= 2) return uniq;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of uniq) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop(); lower.push(p); }
  for (let i = uniq.length - 1; i >= 0; i--) { const p = uniq[i]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Minimum-area enclosing rectangle of a convex polygon (each edge tried as a side).
 * @param {number[][]} hull
 * @returns {{ corners: number[][], width: number, height: number }} `width` along the chosen side
 */
export function minAreaRect(hull) {
  if (hull.length === 0) return { corners: [], width: 0, height: 0 };
  if (hull.length === 1) return { corners: [hull[0], hull[0], hull[0], hull[0]].map(p => [...p]), width: 0, height: 0 };
  let best = null;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const vx = -uy, vy = ux;
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const p of hull) {
      const dx = p[0] - a[0], dy = p[1] - a[1];
      const s = dx * ux + dy * uy, t = dx * vx + dy * vy;
      if (s < s0) s0 = s; if (s > s1) s1 = s;
      if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    const area = (s1 - s0) * (t1 - t0);
    if (!best || area < best.area - 1e-9) best = { area, a, ux, uy, vx, vy, s0, s1, t0, t1 };
  }
  const { a, ux, uy, vx, vy, s0, s1, t0, t1 } = best;
  const at = (s, t) => [a[0] + ux * s + vx * t, a[1] + uy * s + vy * t];
  return { corners: [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)], width: s1 - s0, height: t1 - t0 };
}

/**
 * Order four corners the way PaddleOCR's get_mini_boxes does: top-left,
 * top-right, bottom-right, bottom-left, from the two leftmost and the two
 * rightmost points.
 */
export function miniBoxOrder(corners) {
  const p = corners.map(c => [c[0], c[1]]).sort((m, n) => m[0] - n[0]);
  const [i1, i4] = p[1][1] > p[0][1] ? [0, 1] : [1, 0];
  const [i2, i3] = p[3][1] > p[2][1] ? [2, 3] : [3, 2];
  return [p[i1], p[i2], p[i3], p[i4]];
}

/** Mean of `prob` inside a convex quadrilateral, over the pixels whose centre it covers. */
export function boxScore(prob, width, height, quad) {
  const xs = quad.map(q => q[0]), ys = quad.map(q => q[1]);
  const xmin = Math.max(0, Math.min(width - 1, Math.floor(Math.min(...xs))));
  const xmax = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(...xs))));
  const ymin = Math.max(0, Math.min(height - 1, Math.floor(Math.min(...ys))));
  const ymax = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(...ys))));
  let sum = 0, n = 0;
  for (let y = ymin; y <= ymax; y++) {
    const span = rowSpan(quad, y);
    if (!span) continue;
    const a = Math.max(xmin, Math.ceil(span[0] - 1e-6)), b = Math.min(xmax, Math.floor(span[1] + 1e-6));
    const o = y * width;
    for (let x = a; x <= b; x++) { sum += prob[o + x]; n++; }
  }
  return n ? sum / n : 0;
}

/** Horizontal extent [x0, x1] of a convex polygon at height y, or null. */
export function rowSpan(poly, y) {
  let x0 = Infinity, x1 = -Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
    if ((y < Math.min(ay, by) - 1e-6) || (y > Math.max(ay, by) + 1e-6)) continue;
    if (Math.abs(by - ay) < 1e-9) { x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx); continue; }
    const x = ax + (bx - ax) * (y - ay) / (by - ay);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
  }
  return x0 <= x1 ? [x0, x1] : null;
}

/**
 * Grow a rectangle by d = area × ratio / perimeter on every side, which is
 * what offsetting it with round joins and taking the minimum-area rectangle
 * of the result gives.
 * @param {{ corners: number[][], width: number, height: number }} rect
 */
export function unclipRect(rect, ratio) {
  const { corners: c, width: w, height: h } = rect;
  const perimeter = 2 * (w + h);
  if (!perimeter) return { corners: c.map(p => [...p]), width: w, height: h };
  const d = (w * h * ratio) / perimeter;
  const ux = w ? (c[1][0] - c[0][0]) / w : 1, uy = w ? (c[1][1] - c[0][1]) / w : 0;
  const vx = h ? (c[3][0] - c[0][0]) / h : -uy, vy = h ? (c[3][1] - c[0][1]) / h : ux;
  const o = [c[0][0] - ux * d - vx * d, c[0][1] - uy * d - vy * d];
  const W = w + 2 * d, H = h + 2 * d;
  const at = (s, t) => [o[0] + ux * s + vx * t, o[1] + uy * s + vy * t];
  return { corners: [at(0, 0), at(W, 0), at(W, H), at(0, H)], width: W, height: H };
}

/**
 * Corners clockwise from the top-left as PaddleOCR orders them before cropping:
 * smallest and largest x + y, then the other two by y − x.
 */
export function orderClockwise(pts) {
  const s = pts.map(p => p[0] + p[1]);
  const iMin = s.indexOf(Math.min(...s));
  let iMax = s.indexOf(Math.max(...s));
  if (iMax === iMin) iMax = (iMin + 2) % 4;
  const rest = [0, 1, 2, 3].filter(i => i !== iMin && i !== iMax);
  const d = rest.map(i => pts[i][1] - pts[i][0]);
  const [tr, bl] = d[0] <= d[1] ? rest : [rest[1], rest[0]];
  return [pts[iMin], pts[tr], pts[iMax], pts[bl]].map(p => [p[0], p[1]]);
}

/**
 * Probability map → text quadrilaterals in image pixels.
 * @param {Float32Array} prob height × width map of the detector
 * @param {number} width map width (the detector input)
 * @param {number} height map height
 * @param {{ thresh: number, boxThresh: number, maxCandidates: number, unclipRatio: number, minSize: number }} cfg
 * @param {number} destWidth image width
 * @param {number} destHeight image height
 * @returns {{ points: number[][], score: number }[]}
 */
export function dbPostprocess(prob, width, height, cfg, destWidth, destHeight) {
  const out = [];
  const found = regions(prob, width, height, cfg.thresh).slice(0, cfg.maxCandidates);
  for (const r of found) {
    if (r.xmax - r.xmin + 1 < cfg.minSize && r.ymax - r.ymin + 1 < cfg.minSize) continue;
    const rect = minAreaRect(convexHull(r.points, r.count));
    if (Math.min(rect.width, rect.height) < cfg.minSize) continue;
    const quad = miniBoxOrder(rect.corners);
    const score = boxScore(prob, width, height, quad);
    if (score < cfg.boxThresh) continue;
    const grown = unclipRect(rect, cfg.unclipRatio);
    if (Math.min(grown.width, grown.height) < cfg.minSize + 2) continue;
    const box = miniBoxOrder(grown.corners).map(([x, y]) => [
      Math.min(destWidth, Math.max(0, Math.round((x / width) * destWidth))),
      Math.min(destHeight, Math.max(0, Math.round((y / height) * destHeight))),
    ]);
    out.push({ points: box, score });
  }
  return out;
}

/**
 * What PaddleOCR keeps of the detections before cropping: corners in clockwise
 * order, clipped to the image, and only boxes more than 3 pixels each way.
 * @param {{ points: number[][], score: number }[]} boxes
 */
export function filterBoxes(boxes, width, height) {
  const out = [];
  for (const b of boxes) {
    const p = orderClockwise(b.points).map(([x, y]) => [Math.min(Math.max(x, 0), width - 1), Math.min(Math.max(y, 0), height - 1)]);
    const w = Math.trunc(Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]));
    const h = Math.trunc(Math.hypot(p[0][0] - p[3][0], p[0][1] - p[3][1]));
    if (w <= 3 || h <= 3) continue;
    out.push({ points: p, score: b.score });
  }
  return out;
}
