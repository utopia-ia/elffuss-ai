// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// From a box to text: the perspective crop (bicubic, edges repeated, tall
// strips turned), the recogniser's input (height 48, shape kept, padding,
// [−1, 1], BGR), the batches, greedy CTC decoding, the reading order and the
// comparison helpers (normalisation, character error rate).
import test from 'node:test';
import assert from 'node:assert/strict';
import { perspective, solve, cubicWeights, cropQuad, rotateLeft } from '../../sdk/ocr/crop.js';
import { batchWidth, stripWidth, planBatches, writeStrip, ctcDecode } from '../../sdk/ocr/rec.js';
import { readingRows, pageText, boundingBox, cleanLine, normalizeText, characterErrorRate } from '../../sdk/ocr/order.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const REC = { height: 48, width: 320, maxWidth: 3200, bgr: true };

function rgba(width, height, f) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = f(x, y); data.set([r, g, b, 255], (y * width + x) * 4); }
  return { width, height, data };
}

test('perspective transform maps the four corners; the solver is exact', () => {
  const to = [[10, 20], [110, 25], [105, 75], [5, 70]];
  const H = perspective([[0, 0], [100, 0], [100, 50], [0, 50]], to);
  const map = ([x, y]) => { const d = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };
  [[0, 0], [100, 0], [100, 50], [0, 50]].forEach((p, i) => { const q = map(p); assert.ok(close(q[0], to[i][0], 1e-6) && close(q[1], to[i][1], 1e-6), `${p} → ${q}`); });
  assert.deepEqual(solve([[2, 0], [0, 4]], [2, 8]), [1, 2]);
  assert.throws(() => solve([[1, 1], [1, 1]], [1, 2]), RangeError);
});

test('cubic weights sum to one and are exact at whole pixels', () => {
  for (const t of [0, 0.25, 0.5, 0.9]) { const w = cubicWeights(t); assert.ok(close(w[0] + w[1] + w[2] + w[3], 1, 1e-12)); }
  assert.deepEqual([...cubicWeights(0)], [0, 1, 0, 0]);
});

test('an upright box is copied pixel for pixel; a tall one is turned a quarter to the left', () => {
  const img = rgba(40, 30, (x, y) => [x * 5, y * 7, (x + y) % 256]);
  const c = cropQuad(img, [[5, 4], [25, 4], [25, 14], [5, 14]]);
  assert.deepEqual([c.width, c.height, c.rotated], [20, 10, false]);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) {
    const o = (y * 20 + x) * 3, s = ((y + 4) * 40 + x + 5) * 4;
    assert.deepEqual([...c.data.subarray(o, o + 3)], [img.data[s], img.data[s + 1], img.data[s + 2]], `pixel ${x},${y}`);
  }
  const tall = cropQuad(img, [[2, 2], [8, 2], [8, 22], [2, 22]]);
  assert.deepEqual([tall.width, tall.height, tall.rotated], [20, 6, true]);
  assert.equal(cropQuad(img, [[1, 1], [1, 1], [1, 1], [1, 1]]), null);
  // Outside the image the edge repeats.
  const edge = cropQuad(img, [[-5, 0], [5, 0], [5, 4], [-5, 4]]);
  assert.deepEqual([...edge.data.subarray(0, 3)], [img.data[0], img.data[1], img.data[2]]);
});

test('quarter turn to the left, as numpy rot90', () => {
  // 3 × 2 strip, one channel shown: [[1,2,3],[4,5,6]] → [[3,6],[2,5],[1,4]]
  const data = new Uint8Array([1, 2, 3, 4, 5, 6].flatMap(v => [v, 0, 0]));
  const r = rotateLeft({ width: 3, height: 2, data });
  assert.deepEqual([r.width, r.height], [2, 3]);
  assert.deepEqual([...r.data].filter((_, i) => i % 3 === 0), [3, 6, 2, 5, 1, 4]);
});

test('batch width: at least 320 at height 48, the widest strip otherwise, at most 3200', () => {
  assert.equal(batchWidth([{ width: 50, height: 50 }], REC), 320);
  assert.equal(batchWidth([{ width: 1000, height: 48 }, { width: 100, height: 48 }], REC), 1000);
  assert.equal(batchWidth([{ width: 99999, height: 48 }], REC), 3200);
  assert.equal(stripWidth({ width: 100, height: 48 }, 320, 48), 100);
  assert.equal(stripWidth({ width: 101, height: 50 }, 320, 48), 97);
  assert.equal(stripWidth({ width: 9999, height: 48 }, 3200, 48), 3200);
});

test('batches: narrow shapes first, bounded in count and in output steps', () => {
  const strips = [{ width: 900, height: 48 }, { width: 100, height: 48 }, { width: 300, height: 48 }, { width: 3000, height: 48 }];
  assert.deepEqual(planBatches(strips, REC, { maxBatch: 1 }), [[1], [2], [0], [3]]);
  assert.deepEqual(planBatches(strips, REC, { maxBatch: 6, maxSteps: 640 }), [[1, 2, 0], [3]]);
  for (const b of planBatches(Array.from({ length: 20 }, () => ({ width: 320, height: 48 })), REC)) assert.ok(b.length <= 6);
});

test('recogniser input: resized to 48 rows, [−1, 1], BGR planes, the rest zero', () => {
  const strip = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 0, 0, 255]) };
  const imgW = 320;
  const t = new Float32Array(2 * 3 * 48 * imgW);
  const w = writeStrip(t, 1, imgW, strip, REC);
  assert.equal(w, 96);
  const plane = 48 * imgW, base = 3 * plane;
  // Blue plane first: the left pixel (red) has no blue → −1; the right one (blue) → +1.
  assert.equal(t[base + 0], -1);
  assert.equal(t[base + 95], 1);
  assert.equal(t[base + 2 * plane + 0], 1, 'red plane, left pixel');
  assert.equal(t[base + 96], 0, 'padding');
  assert.ok(t.subarray(0, base).every(v => v === 0), 'slot 0 untouched');
});

test('CTC: best class per step, repeats merged, blanks dropped, mean probability', () => {
  const vocab = ['', 'a', 'b', ' '];
  const steps = [[0, 0.9, 0.05, 0.05], [0, 0.8, 0.1, 0.1], [0.9, 0.05, 0.05, 0], [0.1, 0.7, 0.1, 0.1], [0.2, 0, 0, 0.8], [0, 0, 1, 0]];
  const probs = Float32Array.from(steps.flat());
  const [r] = ctcDecode(probs, 1, steps.length, 4, vocab);
  assert.equal(r.text, 'aa b');
  assert.ok(close(r.score, (0.9 + 0.7 + 0.8 + 1) / 4, 1e-6));
  const empty = ctcDecode(Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0]), 1, 2, 4, vocab)[0];
  assert.deepEqual(empty, { text: '', score: 0 });
  assert.equal(ctcDecode(Float32Array.from([...steps.flat(), ...steps.flat()]), 2, 6, 4, vocab).length, 2);
});

const line = (text, xmin, ymin, xmax, ymax) => ({ text, box: { xmin, ymin, xmax, ymax } });

test('reading order: rows by vertical overlap, top to bottom, left to right', () => {
  const lines = [line('right', 300, 12, 400, 40), line('second', 10, 60, 200, 90), line('left', 10, 10, 200, 42), line('far', 500, 70, 600, 95)];
  const rows = readingRows(lines);
  assert.deepEqual(rows.map(r => r.map(l => l.text)), [['left', 'right'], ['second', 'far']]);
  assert.deepEqual(pageText(lines), { lines: rows.flat(), text: 'left right\nsecond far' });
  // Overlapping by less than half the smaller height: separate rows.
  assert.deepEqual(readingRows([line('a', 0, 0, 10, 20), line('b', 20, 12, 30, 32)]).length, 2);
  assert.deepEqual(boundingBox([[3, 4], [10, 2], [8, 9]]), { xmin: 3, ymin: 2, xmax: 10, ymax: 9 });
});

test('text helpers: clean lines, normalisation and character error rate', () => {
  assert.equal(cleanLine('  a   b\t c '), 'a b c');
  assert.equal(cleanLine('Ñandú'), 'Ñandú', 'NFC');
  assert.equal(normalizeText('\n a  b \r\n c  d \n\n'), 'a b\nc d');
  assert.equal(characterErrorRate('abc', 'abc'), 0);
  assert.equal(characterErrorRate('abd', 'abc'), 1 / 3);
  assert.equal(characterErrorRate('', 'ab'), 1);
  assert.equal(characterErrorRate('x', ''), 1);
  assert.equal(characterErrorRate('Sí, dentro', 'Si, dentro'), 0.1);
});
