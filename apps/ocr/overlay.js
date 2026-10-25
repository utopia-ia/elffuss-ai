// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The boxes of a page drawn over the page: two canvases in a figure.stage, the
// page scaled to a display width and, on top, each line's polygon. Colours
// come from the page's colour variables when painting; nothing is written in
// here. Only one page is drawn at a time, and its canvases are emptied when it
// is closed, so a long list keeps no pixels around.

/** Width the page is drawn at (the canvas scales it further with the layout). */
export const DISPLAY_WIDTH = 1600;

/** Scale of a page drawn at most `max` pixels wide. */
export function displayScale(width, max = DISPLAY_WIDTH) {
  return width > max ? max / width : 1;
}

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Draw a page and its lines into a figure.stage (two canvases: the page, and
 * canvas.overlay on top).
 * @param {HTMLElement} figure
 * @param {CanvasImageSource & { width: number, height: number }} image the page, at its own size
 * @param {{ polygon: number[][] }[]} lines in the page's pixels
 * @param {{ width: number, height: number }} page the page's size in pixels
 */
export function drawPage(figure, image, lines, page) {
  const k = displayScale(page.width);
  const w = Math.max(1, Math.round(page.width * k)), h = Math.max(1, Math.round(page.height * k));
  const [base, over] = figure.querySelectorAll('canvas');
  for (const c of [base, over]) { c.width = w; c.height = h; }
  base.getContext('2d').drawImage(image, 0, 0, w, h);
  const ctx = over.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.lineWidth = Math.max(1.5, 2 * Math.min(1, w / 1000));
  ctx.strokeStyle = cssVar('--accent2') || cssVar('--accent');
  for (const l of lines) {
    const p = l.polygon;
    if (!p?.length) continue;
    ctx.beginPath();
    ctx.moveTo(p[0][0] * k, p[0][1] * k);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0] * k, p[i][1] * k);
    ctx.closePath();
    ctx.stroke();
  }
  figure.hidden = false;
}

/** Empty a figure's canvases and hide it. */
export function clearPage(figure) {
  for (const c of figure.querySelectorAll('canvas')) { c.width = 0; c.height = 0; }
  figure.hidden = true;
}
