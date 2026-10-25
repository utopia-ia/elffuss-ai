// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Pure helpers over a depth map: normalise the model's values to 0-1, paint
// them in grey (lighter is nearer) or along a ramp of colours that the caller
// passes. No colour is written here: a site reads its ramp from its CSS
// variables. Depth Anything gives relative depth (larger is nearer), so 1 is
// the nearest point of the photo and 0 the farthest, not a distance.

/**
 * Scale raw depth values to 0-1: the smallest becomes 0 (farthest), the largest
 * 1 (nearest). Values that are not finite become 0. A flat map gives all zeros.
 * @param {ArrayLike<number>} values raw values, one per pixel
 * @returns {{ depth: Float32Array, min: number, max: number }} the new values and the raw range
 */
export function normalizeDepth(values) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const depth = new Float32Array(values.length);
  if (!(max > min)) return { depth, min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
  const k = 1 / (max - min);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    depth[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, (v - min) * k)) : 0;
  }
  return { depth, min, max };
}

/**
 * RGBA pixels of a depth map in grey: 0 is black, 1 is white, alpha opaque.
 * @param {ArrayLike<number>} depth values 0-1
 * @returns {Uint8ClampedArray}
 */
export function depthToGrey(depth) {
  const out = new Uint8ClampedArray(depth.length * 4);
  for (let i = 0, j = 0; i < depth.length; i++, j += 4) {
    const g = Math.round(Math.min(1, Math.max(0, depth[i] || 0)) * 255);
    out[j] = g; out[j + 1] = g; out[j + 2] = g; out[j + 3] = 255;
  }
  return out;
}

/**
 * The colour of a ramp at `t` (0-1), interpolated linearly between evenly
 * spaced stops.
 * @param {ArrayLike<ArrayLike<number>>} stops two or more `[r, g, b]` (0-255), far first
 * @param {number} t
 * @returns {[number, number, number]}
 */
export function rampColor(stops, t) {
  if (!stops || stops.length < 2) throw new TypeError('a ramp needs two or more colours');
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [0, 1, 2].map(c => Math.round(a[c] + (b[c] - a[c]) * f));
}

/** Entries of the lookup table colorizeDepth builds. */
export const RAMP_STEPS = 1024;

/**
 * RGBA pixels of a depth map along a ramp of colours: the first stop for the
 * farthest point (0), the last for the nearest (1). Alpha is opaque.
 * @param {ArrayLike<number>} depth values 0-1
 * @param {ArrayLike<ArrayLike<number>>} stops two or more `[r, g, b]` (0-255), far first
 * @returns {Uint8ClampedArray}
 */
export function colorizeDepth(depth, stops) {
  const lut = new Uint8Array(RAMP_STEPS * 3);
  for (let s = 0; s < RAMP_STEPS; s++) lut.set(rampColor(stops, s / (RAMP_STEPS - 1)), s * 3);
  const out = new Uint8ClampedArray(depth.length * 4);
  for (let i = 0, j = 0; i < depth.length; i++, j += 4) {
    const v = Math.min(1, Math.max(0, depth[i] || 0));
    const k = Math.round(v * (RAMP_STEPS - 1)) * 3;
    out[j] = lut[k]; out[j + 1] = lut[k + 1]; out[j + 2] = lut[k + 2]; out[j + 3] = 255;
  }
  return out;
}
