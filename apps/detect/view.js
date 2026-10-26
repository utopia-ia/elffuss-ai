// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What the detect page shows, as pure functions: which objects pass the
// confidence slider, how a label, a score and a box are written in each
// language, the geometry of the drawing, and the JSON a user downloads. No DOM
// here, so every piece has a unit test.

/**
 * Objects at or above a threshold, in the order given (highest score first).
 * @param {{ score: number }[]} objects
 * @param {number} threshold
 */
export function visible(objects, threshold) {
  return (objects || []).filter(o => o.score >= threshold);
}

/** A score as a whole percentage (0.937 → 94). */
export function percent(score) {
  return Math.round(Math.min(1, Math.max(0, Number(score) || 0)) * 100);
}

/** The slider's value as the page writes it: two decimals, a comma in Spanish. */
export function formatThreshold(value, lang) {
  const s = (Number(value) || 0).toFixed(2);
  return lang === 'es' ? s.replace('.', ',') : s;
}

/**
 * The name of a class in the page's language. The model names its classes in
 * English; Spanish names come from labels.es.json, with the English one as a
 * fallback.
 * @param {string} label
 * @param {'es'|'en'} lang
 * @param {Record<string, string>|null} names
 */
export function className(label, lang, names) {
  return lang === 'es' && names && names[label] ? names[label] : label;
}

/** A box with whole pixels (for the list and the JSON). */
export function roundBox(box) {
  return { xmin: Math.round(box.xmin), ymin: Math.round(box.ymin), xmax: Math.round(box.xmax), ymax: Math.round(box.ymax) };
}

/** A box as fractions of the image (what a camera frame is compared in). */
export function normalizeBox(box, width, height) {
  return { xmin: box.xmin / width, ymin: box.ymin / height, xmax: box.xmax / width, ymax: box.ymax / height };
}

/**
 * One colour slot per class, in the order the classes first appear, so the boxes
 * of one class share a colour. The page turns a slot into one of its colour
 * variables.
 * @param {{ label: string }[]} objects
 * @param {number} slots
 * @returns {number[]} the slot of each object
 */
export function colourSlots(objects, slots) {
  const seen = new Map();
  return objects.map(o => {
    if (!seen.has(o.label)) seen.set(o.label, seen.size % Math.max(1, slots));
    return seen.get(o.label);
  });
}

/**
 * Line width and font size of the drawing, in pixels of the image: relative to
 * its width, and never thinner than 2 nor smaller than 12 pixels on the screen
 * when the image is shown `displayWidth` pixels wide.
 */
export function drawingScale(width, displayWidth = width) {
  const k = displayWidth > 0 ? width / displayWidth : 1;
  return { line: Math.max(Math.ceil(2 * k), Math.round(width / 320)), font: Math.max(Math.ceil(12 * k), Math.round(width / 45)) };
}

/**
 * Where the label of a box goes: above the box when there is room, otherwise
 * just inside its top edge; never outside the image.
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function chipRect(box, textWidth, fontSize, width, height) {
  const pad = Math.round(fontSize * 0.35);
  const w = Math.min(width, Math.ceil(textWidth + pad * 2));
  const h = Math.min(height, Math.ceil(fontSize * 1.4));
  const x = Math.min(Math.max(0, box.xmin), Math.max(0, width - w));
  const y = box.ymin - h >= 0 ? box.ymin - h : Math.min(Math.max(0, box.ymin), Math.max(0, height - h));
  return { x, y, w, h };
}

/**
 * The JSON a user downloads: what was analysed, by which model and backend, the
 * threshold of the slider, and the objects that pass it with their English
 * class names (the model's own), scores to four decimals and whole-pixel boxes.
 * @param {{ source: string, model: string, device: string, threshold: number, result: { width: number, height: number, objects: { label: string, score: number, box: object }[] } }} o
 */
export function resultJson({ source, model, device, threshold, result }) {
  const objects = visible(result.objects, threshold).map(o => ({ label: o.label, score: Math.round(o.score * 1e4) / 1e4, box: roundBox(o.box) }));
  return JSON.stringify({ source, width: result.width, height: result.height, model, device, threshold, objects }, null, 2) + '\n';
}

/** A file name for a download: the image's name without its extension, and a suffix. */
export function downloadName(name, suffix, ext) {
  const base = String(name || '').replace(/\.[^./\\]*$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim() || 'image';
  return `${base}-${suffix}.${ext}`;
}
