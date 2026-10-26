// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Reading order of the lines of one page, and the text made from them. Boxes
// whose vertical extents overlap by more than half the smaller height share a
// row; rows go from top to bottom and the boxes of a row from left to right.
// The boxes of a row are joined with a space and the rows with a line break.
// Plus the helpers to compare a text with a reference: normalisation (NFC,
// single spaces, trimmed lines) and the character error rate.

/** Axis-aligned box of a polygon. */
export function boundingBox(points) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of points) {
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  return { xmin, ymin, xmax, ymax };
}

const overlap = (a, b) => Math.min(a.ymax, b.ymax) - Math.max(a.ymin, b.ymin);

/**
 * Group lines into rows and order them.
 * @template {{ box: { xmin: number, ymin: number, xmax: number, ymax: number } }} L
 * @param {L[]} lines
 * @returns {L[][]} rows, top to bottom, each left to right
 */
export function readingRows(lines) {
  const sorted = [...lines].sort((a, b) => a.box.ymin - b.box.ymin || a.box.xmin - b.box.xmin);
  const rows = [];
  for (const l of sorted) {
    const h = l.box.ymax - l.box.ymin;
    const row = rows.find(r => r.some(m => overlap(m.box, l.box) > 0.5 * Math.min(h, m.box.ymax - m.box.ymin)));
    if (row) row.push(l); else rows.push([l]);
  }
  for (const r of rows) r.sort((a, b) => a.box.xmin - b.box.xmin || a.box.ymin - b.box.ymin);
  rows.sort((a, b) => Math.min(...a.map(l => l.box.ymin)) - Math.min(...b.map(l => l.box.ymin)));
  return rows;
}

/** One line of recognised text: trimmed, spaces collapsed. */
export function cleanLine(s) {
  return String(s).normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * The lines in reading order and the page text.
 * @template {{ text: string, box: object }} L
 * @param {L[]} lines
 * @returns {{ lines: L[], text: string }}
 */
export function pageText(lines) {
  const rows = readingRows(lines);
  return { lines: rows.flat(), text: rows.map(r => r.map(l => l.text).join(' ')).join('\n') };
}

/** NFC, runs of spaces as one, every line trimmed, no empty lines at the ends. */
export function normalizeText(s) {
  return String(s).normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
    .map(l => l.replace(/[ \t ]+/g, ' ').trim()).join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * Character error rate: edit distance between two texts (by code point) over
 * the length of the reference. Both are normalised first.
 * @param {string} hypothesis
 * @param {string} reference
 */
export function characterErrorRate(hypothesis, reference) {
  const a = [...normalizeText(hypothesis)], b = [...normalizeText(reference)];
  if (!b.length) return a.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / b.length;
}
