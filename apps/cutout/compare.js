// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Before and after on one canvas: the original to the left of the split, the
// cut-out to the right over a checkerboard so that its transparency shows. The
// split moves with an <input type="range"> (which brings the keyboard and screen
// readers) and by dragging on the picture. The colours are the page's CSS
// variables, read at every paint; nothing here writes one or any style.

/** Longest side of the comparison canvas; the download keeps the full size. */
export const PREVIEW_SIDE = 1600;

/**
 * Size of a picture fitted within `max` on its longest side (never enlarged).
 * @param {number} width
 * @param {number} height
 * @param {number} [max]
 */
export function fitWithin(width, height, max = PREVIEW_SIDE) {
  const k = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Column of the split on a canvas `width` wide for a slider value (0-100). */
export function splitAt(value, width) {
  const v = Number(value);
  return Math.round((width * (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50)) / 100);
}

/** Slider value (0-100) of a pointer at `clientX` over a box starting at `left`, `width` wide. */
export function valueAt(clientX, left, width) {
  if (!(width > 0)) return 50;
  return Math.min(100, Math.max(0, ((clientX - left) / width) * 100));
}

/** Side of a checkerboard square, so that a picture shows a few dozen across. */
export function cellSize(width, height) {
  return Math.max(6, Math.round(Math.max(width, height) / 48));
}

/**
 * Draw a comparison on `canvas` and wire its slider and pointer. Both pictures
 * are scaled once to the canvas, so moving the split only repaints.
 * @param {{ canvas: HTMLCanvasElement, range: HTMLInputElement, before: ImageBitmapSource, after: ImageBitmapSource,
 *   width: number, height: number, root?: Element }} o
 *   `before` is the original, `after` the cut-out; `width` × `height` is the cut-out's size.
 * @returns {Promise<{ paint(): void, dispose(): void }>}
 */
export async function createCompare({ canvas, range, before, after, width, height, root = document.documentElement }) {
  const size = fitWithin(width, height);
  const scale = { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high', imageOrientation: 'from-image' };
  [before, after] = await Promise.all([createImageBitmap(before, scale), createImageBitmap(after, scale)]);
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  const color = name => getComputedStyle(root).getPropertyValue(name).trim();

  function paint() {
    const { width: w, height: h } = canvas;
    const x = splitAt(range.value, w);
    ctx.clearRect(0, 0, w, h);
    if (x < w) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, w - x, h);
      ctx.clip();
      ctx.fillStyle = color('--bg2');
      ctx.fillRect(x, 0, w - x, h);
      ctx.fillStyle = color('--bg3');
      const s = cellSize(w, h);
      for (let cy = 0; cy * s < h; cy++) for (let cx = 0; cx * s < w; cx++) if ((cx + cy) % 2) ctx.fillRect(cx * s, cy * s, s, s);
      ctx.drawImage(after, 0, 0, w, h);
      ctx.restore();
    }
    if (x > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, h);
      ctx.clip();
      ctx.drawImage(before, 0, 0, w, h);
      ctx.restore();
    }
    if (x > 0 && x < w) {
      const lw = Math.max(2, Math.round(w / 400));
      ctx.fillStyle = color('--accent');
      ctx.fillRect(Math.min(w - lw, Math.max(0, Math.round(x - lw / 2))), 0, lw, h);
    }
  }

  let pointer = null;
  const follow = e => {
    const r = canvas.getBoundingClientRect();
    range.value = String(Math.round(valueAt(e.clientX, r.left, r.width)));
    paint();
  };
  const onDown = e => { pointer = e.pointerId; canvas.setPointerCapture?.(e.pointerId); follow(e); };
  const onMove = e => { if (pointer === e.pointerId) follow(e); };
  const onUp = e => { if (pointer === e.pointerId) pointer = null; };
  const scheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  range.addEventListener('input', paint);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  scheme?.addEventListener?.('change', paint);
  paint();

  return {
    paint,
    dispose() {
      range.removeEventListener('input', paint);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      scheme?.removeEventListener?.('change', paint);
      before.close();
      after.close();
    },
  };
}
