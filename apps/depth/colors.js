// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Colours for drawing, read from the page's CSS variables when painting: the
// site writes no colour of its own, so the shared look can change them all.
// Any colour syntax the browser understands works, because a 1×1 canvas turns
// the value into its red, green and blue.

/** Variables of the depth map's colour ramp, from the farthest to the nearest. */
export const RAMP_VARS = Object.freeze(['--line', '--accent2', '--accent', '--fg']);

/**
 * `[r, g, b]` (0-255) of a CSS colour value, or null when it is not a colour.
 * @param {string} value
 * @returns {[number, number, number] | null}
 */
export function cssColor(value) {
  const v = String(value ?? '').trim();
  if (!v || (globalThis.CSS?.supports && !globalThis.CSS.supports('color', v))) return null;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/**
 * The colour of a CSS variable as computed on an element (the root by default), or null.
 * @param {string} name e.g. `--accent`
 * @param {Element} [el]
 */
export function varColor(name, el = document.documentElement) {
  return cssColor(getComputedStyle(el).getPropertyValue(name));
}

/** The ramp of the depth map, far first, or null when a variable is not a colour. */
export function readRamp(el) {
  const stops = RAMP_VARS.map(v => varColor(v, el));
  return stops.every(Boolean) ? stops : null;
}
