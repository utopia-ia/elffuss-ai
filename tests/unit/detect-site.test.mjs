// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The detect site's own files: Spanish names for the 80 COCO classes the model
// knows, its built page (camera and threshold controls, the stage), the export
// of the task in package.json, the browser spec's pure helpers (matching
// detections with hand boxes, the fake camera's .y4m, the reference outputs),
// and the decoder on the model's real outputs for the test photo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../../scripts/build.mjs';
import { sites as readSites } from '../../deploy/sites.mjs';
import { iou, matchToHand, normalizedHand, rgbaToI420, y4m, topRows, describeMatch } from '../browser/specs/detect.spec.mjs';
import { sigmoid, labelList, decodeDetections } from '../../sdk/detect/decode.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = p => readFileSync(join(ROOT, p), 'utf8');
const fixture = name => JSON.parse(read(`tests/fixtures/detect/${name}`));
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// The class names of the pinned model's config (onnx-community RF-DETR Nano), in id order.
const COCO = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear',
  'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork',
  'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake',
  'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush'];

test('Spanish names: one for each of the 80 classes, none empty, none repeated', () => {
  const names = JSON.parse(read('apps/detect/labels.es.json'));
  assert.deepEqual(Object.keys(names).sort(), [...COCO].sort());
  const values = Object.values(names);
  assert.ok(values.every(v => typeof v === 'string' && v.trim() === v && v.length > 0));
  assert.equal(new Set(values).size, 80);
  assert.equal(names.dog, 'perro');
  assert.equal(names.cat, 'gato');
});

test('the saved reference outputs name exactly these classes', () => {
  const g = JSON.parse(read('tests/fixtures/detect/golden-outputs-wasm.json'));
  assert.deepEqual(Object.values(g.id2label), COCO);
});

test('the built page: camera, threshold and stage, the camera allowed only here, the task exported', () => {
  const out = mkdtempSync(join(tmpdir(), 'elffuss-ai-detect-'));
  try {
    const sites = readSites(ROOT);
    const site = sites.find(s => s.site === 'detect');
    assert.equal(site.camera, true);
    assert.equal(site.status, 'ready');
    buildSite({ root: ROOT, site, sites, channel: 'pro', buildId: 'test00000000', outDir: out });
    for (const [page, lang] of [['index.html', 'es'], ['en/index.html', 'en']]) {
      const html = readFileSync(join(out, 'detect', page), 'utf8');
      const t = { ...JSON.parse(read('shared/strings.' + lang + '.json')), ...JSON.parse(read('apps/detect/strings.' + lang + '.json')) };
      assert.match(html, new RegExp(`<button class="ghost" type="button" data-action="camera">${t['camera.start']}</button>`));
      assert.match(html, /<button class="ghost" type="button" data-action="stop" hidden>/);
      assert.match(html, /<input id="threshold" type="range" min="0\.3" max="0\.9" step="0\.05" value="0\.5" data-input="threshold">/);
      assert.match(html, /<section class="result" hidden>[\s\S]*<article class="card">[\s\S]*<figure class="stage">[\s\S]*<canvas class="overlay" data-role="overlay" aria-hidden="true"><\/canvas>[\s\S]*<\/figure>/);
      assert.match(html, /<video muted playsinline data-role="video" hidden><\/video>/);
      assert.equal((html.match(/<button class="primary"/g) || []).length, 1);
    }
    for (const f of ['app.js', 'camera.js', 'overlay.js', 'view.js', 'labels.es.json', 'sdk/detect/index.js', 'sdk/detect/impl.js', 'sdk/detect/worker.js', 'sdk/detect/decode.js']) {
      assert.ok(readFileSync(join(out, 'detect', 'v', 'test00000000', f)).length > 0, f);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.exports['./detect'], './sdk/detect/index.js');
});

test('the module adapts runonweb code and says so, in the file and in NOTICE', () => {
  assert.match(read('sdk/detect/decode.js'), /SPDX-License-Identifier: Apache-2\.0 AND MIT[\s\S]*Miguel Ángel Durán[\s\S]*packages\/runonweb\/src\/detect\/index\.ts/);
  assert.match(read('NOTICE'), /sdk\/detect\/decode\.js/);
  for (const f of ['sdk/detect/index.js', 'sdk/detect/impl.js', 'sdk/detect/worker.js', 'apps/detect/app.js', 'apps/detect/camera.js', 'apps/detect/overlay.js', 'apps/detect/view.js']) {
    assert.match(read(f), /^\/\/ SPDX-License-Identifier: Apache-2\.0\n\/\/ Copyright \(c\) 2026 UtopiaIA\n/, f);
  }
});

// ── the browser spec's helpers ───────────────────────────────────────────────

const B = (xmin, ymin, xmax, ymax) => ({ xmin, ymin, xmax, ymax });

test('IoU of boxes', () => {
  assert.equal(iou(B(0, 0, 10, 10), B(0, 0, 10, 10)), 1);
  assert.equal(iou(B(0, 0, 10, 10), B(10, 0, 20, 10)), 0, 'touching is not overlapping');
  assert.equal(iou(B(0, 0, 10, 10), B(5, 0, 15, 10)), 50 / 150);
  assert.equal(iou(B(0, 0, 10, 10), B(20, 20, 30, 30)), 0);
});

test('matching detections with hand boxes: class, IoU, score, and confident extras', () => {
  const hand = [{ label: 'dog', box: B(0, 0, 100, 100) }, { label: 'cat', box: B(200, 0, 300, 100) }];
  const good = [{ label: 'dog', score: 0.9, box: B(5, 5, 100, 95) }, { label: 'cat', score: 0.6, box: B(210, 0, 300, 110) }, { label: 'cup', score: 0.65, box: B(0, 200, 10, 210) }];
  const m = matchToHand(good, hand);
  assert.equal(m.ok, true, describeMatch(m));
  assert.deepEqual(m.pairs.map(p => p.label), ['dog', 'cat']);
  assert.deepEqual(m.extra, [], 'an unmatched object below 0.7 is allowed');
  assert.equal(matchToHand([{ ...good[0] }, { label: 'cat', score: 0.45, box: good[1].box }], hand).ok, false, 'a match needs score ≥ 0.5');
  assert.equal(matchToHand([{ label: 'dog', score: 0.9, box: B(60, 60, 160, 160) }, good[1]], hand).misses[0].label, 'dog', 'and IoU ≥ 0.5');
  assert.equal(matchToHand([{ label: 'cat', score: 0.9, box: hand[0].box }, good[1]], hand).ok, false, 'and the same class');
  const extra = matchToHand([...good, { label: 'dog', score: 0.75, box: B(400, 0, 500, 100) }], hand);
  assert.deepEqual(extra.extra.map(x => x.label), ['dog'], 'a confident detection without a hand box fails');
  assert.equal(extra.ok, false);
  const twice = matchToHand([good[0], { label: 'dog', score: 0.8, box: B(0, 0, 100, 100) }, good[1]], hand);
  assert.equal(twice.extra.length, 1, 'one hand box takes one detection; a confident duplicate is an extra');
  assert.match(describeMatch(extra), /EXTRA dog 0\.75/);
  const nh = normalizedHand({ width: 200, height: 100, boxes: [{ label: 'dog', box: B(20, 10, 100, 50) }] });
  assert.deepEqual(nh, [{ label: 'dog', box: B(0.1, 0.1, 0.5, 0.5) }]);
});

test('RGBA to I420 with BT.601 limited range, and the .y4m around it', () => {
  // 2 × 2: white, black, pure red, pure blue.
  const rgba = Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]);
  const yuv = rgbaToI420(rgba, 2, 2);
  assert.equal(yuv.length, 6);
  assert.deepEqual([...yuv.subarray(0, 4)], [235, 16, 81, 41], 'luma of white, black, red, blue');
  // The chroma of the 2 × 2 block averages the four colours.
  assert.equal(yuv[4], Math.round(128 - 0.1482 * 127.5 - 0.291 * 63.75 + 0.4392 * 127.5));
  assert.equal(yuv[5], Math.round(128 + 0.4392 * 127.5 - 0.3678 * 63.75 - 0.0714 * 127.5));
  assert.throws(() => rgbaToI420(rgba, 3, 2), /even/);
  const file = y4m(2, 2, yuv, { frames: 2, fps: 5 });
  const header = 'YUV4MPEG2 W2 H2 F5:1 Ip A1:1 C420jpeg\n';
  assert.equal(file.subarray(0, header.length).toString(), header);
  assert.equal(file.length, header.length + 2 * ('FRAME\n'.length + 6));
  assert.equal(file.subarray(header.length, header.length + 6).toString(), 'FRAME\n');
});

test('reference outputs keep the best queries by their best named class', () => {
  const classes = 3, queries = 4;
  // Class 0 has no name; query 1 is best only through it, so it ranks by class 2.
  const logits = [0, 1, 2, 9, -5, -4, 0, 3, 1, 0, 0, 5];
  const boxes = Array.from({ length: 16 }, (_, i) => i / 16);
  const rows = topRows({ logits, boxes, classes, queries, named: [1, 2], rows: 2 });
  assert.deepEqual(rows.map(r => r.query), [3, 2]);
  assert.deepEqual(rows[0].logits, [0, 0, 5]);
  assert.deepEqual(rows[0].box, [0.75, 0.8125, 0.875, 0.9375]);
});

test('the model\'s saved outputs for the test photo decode to the hand-boxed dog and cat', () => {
  const g = fixture('golden-outputs-wasm.json');
  const hand = fixture('cajas.json');
  assert.equal(g.model, 'detect/rfdetr-nano');
  assert.equal(g.rows.length, 40);
  const reg = JSON.parse(read('registry/tasks.json'));
  assert.equal(g.revision, reg.models[g.model].parts.main.revision, 'outputs of the pinned revision');
  const logits = { dims: [1, g.rows.length, g.classes], data: Float32Array.from(g.rows.flatMap(r => r.logits)) };
  const boxes = { dims: [1, g.rows.length, 4], data: Float32Array.from(g.rows.flatMap(r => r.box)) };
  const labels = labelList(g.id2label, g.classes);
  assert.equal(labels.filter(Boolean).length, 80, 'the 80 COCO classes');
  const at = threshold => decodeDetections({ logits, boxes, labels, threshold, width: g.width, height: g.height });
  const m = matchToHand(at(0.5), hand.boxes);
  assert.ok(m.ok, JSON.stringify(m));
  assert.deepEqual(at(0.5).map(o => o.label).sort(), ['cat', 'dog'], 'nothing else above 0.5');
  // Lowering the threshold only adds objects, and keeps the order by score.
  const low = at(0.05);
  assert.ok(low.length >= at(0.5).length);
  for (let i = 1; i < low.length; i++) assert.ok(low[i - 1].score >= low[i].score);
  // Every kept object's score is the sigmoid of its best named logit (spot check on the best one).
  const best = g.rows[0].logits.reduce((m2, v, k) => (labels[k] && v > m2 ? v : m2), -Infinity);
  assert.ok(close(low[0].score, sigmoid(Math.fround(best)), 1e-6));
});
