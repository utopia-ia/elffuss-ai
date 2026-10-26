// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The RF-DETR decoder on synthetic outputs: per-class sigmoid, the threshold
// compared in logit space, the best named class of each query, boxes from centre
// and size to corners clamped to the image, highest score first. Its test on the
// model's real outputs is in detect-site.test.mjs, next to the fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sigmoid, logitOf, clampThreshold, labelList, logitShape, cornerBox, decodeDetections, DEFAULT_THRESHOLD } from '../../sdk/detect/decode.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sameBox = (got, want, eps = 1e-4) => {
  assert.ok(got && ['xmin', 'ymin', 'xmax', 'ymax'].every(k => close(got[k], want[k], eps)), `${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
};

test('sigmoid and logitOf are inverses; the ends are infinite', () => {
  for (const p of [0.01, 0.3, 0.5, 0.7, 0.99]) assert.ok(close(sigmoid(logitOf(p)), p, 1e-12), String(p));
  assert.equal(logitOf(0), -Infinity);
  assert.equal(logitOf(-1), -Infinity);
  assert.equal(logitOf(Number.NaN), -Infinity);
  assert.equal(logitOf(1), Infinity);
  assert.equal(logitOf(2), Infinity);
  assert.equal(sigmoid(0), 0.5);
});

test('a threshold is a number from 0 to 1, or the default', () => {
  assert.equal(DEFAULT_THRESHOLD, 0.5);
  assert.equal(clampThreshold(undefined), 0.5);
  assert.equal(clampThreshold(null), 0.5);
  assert.equal(clampThreshold(''), 0.5);
  assert.equal(clampThreshold('abc'), 0.5);
  assert.equal(clampThreshold(Number.NaN), 0.5);
  assert.equal(clampThreshold('0.7'), 0.7);
  assert.equal(clampThreshold(0.25), 0.25);
  assert.equal(clampThreshold(2), 1);
  assert.equal(clampThreshold(-1), 0);
});

test('labels by class index, with holes where a class has no name', () => {
  const l = labelList({ 1: 'person', 3: 'car', 9: 'boat', x: 'bad', 2: '' }, 5);
  assert.deepEqual(l, [undefined, 'person', undefined, 'car', undefined]);
  assert.equal(labelList({}, 3).length, 3);
  assert.deepEqual(labelList(null, 2), [undefined, undefined]);
});

test('logits are [1, queries, classes] or [queries, classes]', () => {
  assert.deepEqual(logitShape([1, 300, 91]), { queries: 300, classes: 91 });
  assert.deepEqual(logitShape([300, 91]), { queries: 300, classes: 91 });
  assert.throws(() => logitShape([2, 300, 91]), { code: 'model-mismatch' });
  assert.throws(() => logitShape([91]), { code: 'model-mismatch' });
  assert.throws(() => logitShape(undefined), { code: 'model-mismatch' });
});

test('boxes: centre and size as fractions to corners in pixels, clamped to the image', () => {
  sameBox(cornerBox(0.5, 0.5, 0.5, 0.5, 200, 100), { xmin: 50, ymin: 25, xmax: 150, ymax: 75 });
  sameBox(cornerBox(0.05, 0.95, 0.2, 0.2, 100, 100), { xmin: 0, ymin: 85, xmax: 15, ymax: 100 });
  assert.equal(cornerBox(0.5, 0.5, 0, 0.2, 100, 100), null, 'empty box');
  assert.equal(cornerBox(1.5, 0.5, 0.2, 0.2, 100, 100), null, 'outside the image');
  assert.equal(cornerBox(Number.NaN, 0.5, 0.2, 0.2, 100, 100), null, 'not a number');
});

// Three queries, four classes; classes 0 and 3 have no name.
const LABELS = [undefined, 'cat', 'dog', undefined];
const logit = p => logitOf(p);
function tensors(rows, boxes) {
  return { logits: { dims: [1, rows.length, 4], data: Float32Array.from(rows.flat()) }, boxes: { dims: [1, boxes.length, 4], data: Float32Array.from(boxes.flat()) } };
}

test('each query gives its best named class; unnamed classes never win', () => {
  const { logits, boxes } = tensors(
    [[logit(0.99), logit(0.2), logit(0.8), logit(0.95)], [logit(0.1), logit(0.6), logit(0.3), -50], [logit(0.05), logit(0.1), logit(0.2), 50]],
    [[0.5, 0.5, 0.2, 0.4], [0.25, 0.25, 0.1, 0.1], [0.9, 0.9, 0.1, 0.1]],
  );
  const out = decodeDetections({ logits, boxes, labels: LABELS, threshold: 0.5, width: 100, height: 200 });
  assert.deepEqual(out.map(o => o.label), ['dog', 'cat'], 'query 0 is a dog even though an unnamed class scores higher; query 2 has nothing named above 0.5');
  assert.ok(close(out[0].score, 0.8, 1e-6) && close(out[1].score, 0.6, 1e-6));
  sameBox(out[0].box, { xmin: 40, ymin: 60, xmax: 60, ymax: 140 });
});

test('the threshold is compared in logit space, with the same answer as comparing scores', () => {
  const { logits, boxes } = tensors([[0, logit(0.62), 0, 0]], [[0.5, 0.5, 0.5, 0.5]]);
  const run = threshold => decodeDetections({ logits, boxes, labels: LABELS, threshold, width: 10, height: 10 });
  const s = sigmoid(logits.data[1]);
  assert.equal(run(s - 1e-6).length, 1, 'just under the score: kept');
  assert.equal(run(s + 1e-6).length, 0, 'just over the score: dropped');
  assert.equal(run(0).length, 1, 'threshold 0 keeps every query with a box');
  assert.equal(run(1).length, 0, 'threshold 1 keeps nothing');
  assert.equal(run(undefined).length, 1, 'the default threshold is 0.5');
  // Many random queries and thresholds: the logit-space cut agrees with a plain score filter.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let trial = 0; trial < 200; trial++) {
    const q = 12;
    const rows = Array.from({ length: q }, () => Array.from({ length: 4 }, () => (rnd() - 0.5) * 12));
    const bx = Array.from({ length: q }, () => [0.2 + rnd() * 0.6, 0.2 + rnd() * 0.6, 0.05 + rnd() * 0.3, 0.05 + rnd() * 0.3]);
    const t = tensors(rows, bx);
    const threshold = rnd();
    const got = decodeDetections({ ...t, labels: LABELS, threshold, width: 100, height: 100 }).map(o => o.score).sort();
    const want = [];
    for (let i = 0; i < q; i++) {
      const best = Math.max(t.logits.data[i * 4 + 1], t.logits.data[i * 4 + 2]);
      if (sigmoid(best) >= threshold) want.push(sigmoid(best));
    }
    assert.deepEqual(got, want.sort(), `trial ${trial}`);
  }
});

test('highest score first; empty or broken boxes and NaN scores are dropped', () => {
  const { logits, boxes } = tensors(
    [[0, logit(0.6), 0, 0], [0, 0, logit(0.9), 0], [0, Number.NaN, Number.NaN, 0], [0, logit(0.95), 0, 0]],
    [[0.5, 0.5, 0.5, 0.5], [0.2, 0.2, 0.2, 0.2], [0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0, 0.5]],
  );
  const out = decodeDetections({ logits, boxes, labels: LABELS, threshold: 0.5, width: 10, height: 10 });
  assert.deepEqual(out.map(o => [o.label, Math.round(o.score * 100)]), [['dog', 90], ['cat', 60]]);
});

test('outputs that do not fit the labels or each other are a model-mismatch', () => {
  const { logits, boxes } = tensors([[0, 0, 0, 0]], [[0.5, 0.5, 0.5, 0.5]]);
  assert.throws(() => decodeDetections({ logits, boxes, labels: ['a', 'b'], width: 1, height: 1 }), { code: 'model-mismatch' });
  assert.throws(() => decodeDetections({ logits, boxes, labels: [undefined, undefined, undefined, undefined], width: 1, height: 1 }), { code: 'model-mismatch' });
  assert.throws(() => decodeDetections({ logits, boxes: { dims: [1, 2, 4], data: new Float32Array(8) }, labels: LABELS, width: 1, height: 1 }), { code: 'model-mismatch' });
  assert.throws(() => decodeDetections({ logits, boxes, labels: LABELS, width: 0, height: 1 }), { code: 'run-failed' });
});
