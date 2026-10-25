// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Drawing the boxes. The colours are the page's CSS variables, read when
// painting (so the shared stylesheet can change them), and the font is the
// page's own: nothing here writes a colour or a font name.

import { colourSlots, drawingScale, chipRect, percent } from './view.js';

/** The colour variables the boxes use, in slot order, and the label text colour. */
const SLOT_VARS = Object.freeze(['--accent', '--accent2', '--fg', '--muted']);

/**
 * Colours and font of the drawing, from the page's styles.
 * @param {Element} [root]
 */
export function readPalette(root = document.documentElement) {
  const cs = getComputedStyle(root);
  const v = name => cs.getPropertyValue(name).trim();
  const slots = SLOT_VARS.map(v).filter(Boolean);
  return { slots: slots.length ? slots : [v('--accent')], text: v('--bg'), family: getComputedStyle(document.body).fontFamily || 'sans-serif' };
}

/**
 * Paint boxes and their labels on a 2D context of the image's size.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} g
 * @param {{ width: number, height: number, objects: { label: string, score: number, box: object }[],
 *   name: (label: string) => string, score: (n: number) => string, palette: ReturnType<typeof readPalette>,
 *   displayWidth?: number }} o `displayWidth`: how wide the image is shown, so labels stay readable
 */
export function paint(g, { width, height, objects, name, score, palette, displayWidth = width }) {
  const { line, font } = drawingScale(width, displayWidth);
  const slots = colourSlots(objects, palette.slots.length);
  g.save();
  g.lineWidth = line;
  g.font = `${font}px ${palette.family}`;
  g.textBaseline = 'middle';
  objects.forEach((o, i) => {
    const colour = palette.slots[slots[i]];
    const { xmin, ymin, xmax, ymax } = o.box;
    g.strokeStyle = colour;
    g.strokeRect(xmin + line / 2, ymin + line / 2, Math.max(0, xmax - xmin - line), Math.max(0, ymax - ymin - line));
    const text = `${name(o.label)} ${score(percent(o.score))}`;
    const chip = chipRect(o.box, g.measureText(text).width, font, width, height);
    g.fillStyle = colour;
    g.fillRect(chip.x, chip.y, chip.w, chip.h);
    g.fillStyle = palette.text;
    g.fillText(text, chip.x + Math.round(font * 0.35), chip.y + chip.h / 2);
  });
  g.restore();
}

/**
 * Size a canvas to the image and paint the boxes on it (cleared first).
 * @param {HTMLCanvasElement} canvas
 * @param {Parameters<typeof paint>[1]} o
 */
export function drawOverlay(canvas, o) {
  if (canvas.width !== o.width) canvas.width = o.width;
  if (canvas.height !== o.height) canvas.height = o.height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  paint(g, o);
}
