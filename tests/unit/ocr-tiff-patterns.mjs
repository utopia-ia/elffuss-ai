// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The pixel patterns behind the TIFF fixtures of tests/fixtures/ocr/tiff/:
// scripts/make-fixtures.mjs writes them out and has the libtiff tools encode
// them in every layout and compression; the unit test decodes those files and
// compares them with the same patterns, computed again here.

/** Bilevel rows of runs of every length, long runs over 2560 included. 1 is black. */
export function bilevel(w = 2700, h = 28) {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0, color = y % 3 === 0 ? 1 : 0, k = 0;
    while (x < w) {
      const len = y % 7 === 6 ? [2600, 5, 2561, 64, 1728, 1][k % 6] : ((y * 37 + k * 101) % 300) + 1 + (k % 5 === 4 ? 1792 : 0);
      const end = Math.min(w, x + len);
      if (color) px.fill(1, y * w + x, y * w + end);
      x = end; color ^= 1; k++;
    }
  }
  return { width: w, height: h, data: px };
}

/** Eight-bit grey. */
export function grey(w = 160, h = 96) {
  const px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 7 + y * 13 + ((x * y) % 17)) & 255;
  return { width: w, height: h, data: px };
}

/** Eight-bit RGB. */
export function colour(w = 128, h = 80) {
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 3; px[o] = (x * 5) & 255; px[o + 1] = (y * 9) & 255; px[o + 2] = (x * y) & 255; }
  return { width: w, height: h, data: px };
}

/** Sixteen-bit grey, as the little-endian raw samples raw2tiff reads. */
export function grey16(w = 64, h = 48) {
  const v = new Uint16Array(w * h);
  for (let i = 0; i < w * h; i++) v[i] = (i * 977) & 0xffff;
  return { width: w, height: h, data: v };
}
