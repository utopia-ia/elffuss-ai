// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// One detected quadrilateral → an upright strip of pixels for the recogniser,
// as PaddleOCR's get_rotate_crop_image does it: the size is the longer of each
// pair of opposite sides, the quadrilateral is mapped onto it with a
// perspective transform and bicubic sampling (edges repeated), and a strip at
// least 1.5 times taller than wide is turned a quarter to the left, because
// vertical text reads that way. Plain arithmetic: no canvas, so every browser
// and backend gets the same pixels.

/**
 * The perspective transform that maps the four `from` points onto the four `to` points.
 * @param {number[][]} from
 * @param {number[][]} to
 * @returns {Float64Array} 3 × 3, row-major, last element 1
 */
export function perspective(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  const h = solve(A, b);
  return Float64Array.from([...h, 1]);
}

/** Gaussian elimination with partial pivoting. Throws on a singular system. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new RangeError('singular system');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Cubic convolution weights for a fractional offset (a = −0.75, as OpenCV). */
export function cubicWeights(t, out = new Float64Array(4)) {
  const A = -0.75;
  const w = d => {
    d = Math.abs(d);
    if (d <= 1) return ((A + 2) * d - (A + 3)) * d * d + 1;
    if (d < 2) return ((A * d - 5 * A) * d + 8 * A) * d - 4 * A;
    return 0;
  };
  out[0] = w(t + 1); out[1] = w(t); out[2] = w(1 - t); out[3] = w(2 - t);
  return out;
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/**
 * Crop a quadrilateral (top-left, top-right, bottom-right, bottom-left) out of
 * RGBA pixels into an RGB strip.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img RGBA
 * @param {number[][]} quad
 * @returns {{ width: number, height: number, data: Uint8Array, rotated: boolean } | null}
 */
export function cropQuad(img, quad) {
  const w = Math.trunc(Math.max(dist(quad[0], quad[1]), dist(quad[2], quad[3])));
  const h = Math.trunc(Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2])));
  if (w < 1 || h < 1) return null;
  let H;
  try { H = perspective([[0, 0], [w, 0], [w, h], [0, h]], quad); } catch { return null; }
  const { width: W, height: Hh, data } = img;
  const out = new Uint8Array(w * h * 3);
  const wx = new Float64Array(4), wy = new Float64Array(4);
  const xi = new Int32Array(4), yi = new Int32Array(4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / d;
      const sy = (H[3] * x + H[4] * y + H[5]) / d;
      const ix = Math.floor(sx), iy = Math.floor(sy);
      cubicWeights(sx - ix, wx); cubicWeights(sy - iy, wy);
      for (let k = 0; k < 4; k++) {
        xi[k] = Math.min(W - 1, Math.max(0, ix - 1 + k)) * 4;
        yi[k] = Math.min(Hh - 1, Math.max(0, iy - 1 + k)) * W * 4;
      }
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let j = 0; j < 4; j++) {
          const row = yi[j] + c;
          acc += wy[j] * (wx[0] * data[row + xi[0]] + wx[1] * data[row + xi[1]] + wx[2] * data[row + xi[2]] + wx[3] * data[row + xi[3]]);
        }
        out[o + c] = acc <= 0 ? 0 : acc >= 255 ? 255 : Math.round(acc);
      }
    }
  }
  if (h / w >= 1.5) return { ...rotateLeft({ width: w, height: h, data: out }), rotated: true };
  return { width: w, height: h, data: out, rotated: false };
}

/** Turn an RGB strip a quarter to the left (numpy's rot90 with k = 1). */
export function rotateLeft({ width: w, height: h, data }) {
  const out = new Uint8Array(w * h * 3);
  // out[i][j] = in[j][w − 1 − i]; out is w rows of h pixels.
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < h; j++) {
      const s = (j * w + (w - 1 - i)) * 3, d = (i * h + j) * 3;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
    }
  }
  return { width: h, height: w, data: out };
}
