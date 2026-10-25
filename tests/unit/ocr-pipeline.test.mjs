// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The OCR of one page and the task implementation, with stand-in sessions
// (no model, no browser): detection boxes → strips → recogniser → text in
// reading order, boxes scaled back to a larger original, low scores dropped,
// a recogniser whose classes do not fit the dictionary refused, and the task's
// load and run with its test hooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ocrPage } from '../../sdk/ocr/pipeline.js';
import { ctcVocabulary } from '../../sdk/ocr/dict.js';

const CHARS = [...'abcdefghijklmnopqrstuvwxyzáéíóúñ¿?!.,', ...Array.from({ length: 80 }, (_, i) => String.fromCharCode(0x4e00 + i))];
const VOCAB = ctcVocabulary(CHARS);
const DET_YML = 'PostProcess:\n  name: DBPostProcess\n  thresh: 0.2\n  box_thresh: 0.45\n  max_candidates: 1000\n  unclip_ratio: 1.4\nPreProcess:\n  transform_ops:\n  - DecodeImage:\n      img_mode: BGR\n';
const REC_YML = `PreProcess:\n  transform_ops:\n  - RecResizeImg:\n      image_shape:\n      - 3\n      - 48\n      - 320\nPostProcess:\n  name: CTCLabelDecode\n  character_dict:\n${CHARS.map(c => `  - '${c.replace(/'/g, "''")}'`).join('\n')}\n`;

class Tensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}

/** A detector that finds text where the image is dark (it reads the B plane of its input). */
function fakeDet() {
  return {
    inputNames: ['x'], outputNames: ['maps'],
    async run(feeds) {
      const x = feeds.x;
      const [, c, h, w] = x.dims;
      if (c !== 3 || h < 32 || w < 32) throw new Error('impossible input shape');
      const map = new Float32Array(h * w);
      // Dark pixels give a negative normalised value.
      for (let i = 0; i < h * w; i++) map[i] = x.data[i] < -1 ? 0.95 : 0.01;
      return { maps: new Tensor('float32', map, [1, 1, h, w]) };
    },
  };
}

/** A recogniser that writes a word chosen by the strip's width, or a wrong number of classes. */
function fakeRec({ classes = VOCAB.length, weak = false } = {}) {
  return {
    inputNames: ['x'], outputNames: ['softmax'],
    outputMetadata: [{ shape: ['b', 't', classes] }],
    calls: 0,
    async run(feeds) {
      this.calls++;
      const [B, , , W] = feeds.x.dims;
      const T = W / 8;
      const out = new Float32Array(B * T * classes);
      for (let b = 0; b < B; b++) {
        // Measure the strip's own width: columns that are not padding.
        let used = 0;
        for (let x = 0; x < W; x++) if (feeds.x.data[b * 3 * 48 * W + 24 * W + x] !== 0) used = x + 1;
        const word = used > 200 ? 'hola mundo' : 'sí';
        const seq = [...word].flatMap(ch => [ch === ' ' ? VOCAB.length - 1 : VOCAB.indexOf(ch), 0]);
        for (let t = 0; t < T; t++) {
          const cls = seq[t] ?? 0;
          const p = weak && cls ? 0.3 : 0.97;
          const o = (b * T + t) * classes;
          out.fill((1 - p) / (classes - 1), o, o + classes);
          out[o + cls] = p;
        }
      }
      return { softmax: new Tensor('float32', out, [B, T, classes]) };
    },
  };
}

/** A white page with two dark bars: a long one on top, a short one below. */
function page(width = 800, height = 400) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const bar = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3); };
  bar(40, 60, 560, 100);
  bar(40, 220, 140, 260);
  return { width, height, data };
}

const models = rec => ({ det: fakeDet(), rec, Tensor, cfg: { det: { thresh: 0.2, boxThresh: 0.45, maxCandidates: 1000, unclipRatio: 1.4, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], scale: 1 / 255, bgr: true, limitSideLen: 736, maxSideLimit: 4000, multiple: 32, minSize: 3 }, rec: { height: 48, width: 320, maxWidth: 3200, bgr: true } }, vocab: VOCAB });

test('one page: two boxes, read one strip per run, in reading order', async () => {
  const rec = fakeRec();
  const r = await ocrPage(models(rec), page());
  assert.equal(r.text, 'hola mundo\nsí');
  assert.equal(rec.calls, 2, 'one recogniser run per strip by default');
  assert.equal(r.lines.length, 2);
  const [a, b] = r.lines;
  assert.ok(a.box.xmin <= 40 && a.box.xmax >= 559 && a.box.ymin <= 60 && a.box.ymax >= 99, JSON.stringify(a.box));
  assert.ok(b.box.ymin > a.box.ymax);
  assert.equal(a.polygon.length, 4);
  assert.ok(a.score > 0.9 && a.score <= 1);
});

test('boxes scaled back to a larger original; batches of several strips give the same text', async () => {
  const one = await ocrPage(models(fakeRec()), page());
  const big = await ocrPage(models(fakeRec()), page(), { scale: 2.5 });
  assert.deepEqual(big.lines.map(l => l.text), one.lines.map(l => l.text), 'same lines, same order');
  big.lines.forEach((l, i) => {
    for (const k of ['xmin', 'ymin', 'xmax', 'ymax']) assert.ok(Math.abs(l.box[k] - one.lines[i].box[k] * 2.5) <= 2.5, `${k}: ${l.box[k]} vs ${one.lines[i].box[k]} × 2.5`);
  });
  const rec = fakeRec();
  const batched = await ocrPage(models(rec), page(), { maxBatch: 6 });
  assert.equal(batched.text, one.text);
  assert.equal(rec.calls, 1);
});

test('lines below the minimum score are dropped; a blank page has no text', async () => {
  const weak = await ocrPage(models(fakeRec({ weak: true })), page());
  assert.deepEqual([weak.text, weak.lines.length], ['', 0]);
  assert.equal((await ocrPage(models(fakeRec({ weak: true })), page(), { minScore: 0 })).lines.length, 2);
  const blank = { width: 300, height: 200, data: new Uint8ClampedArray(300 * 200 * 4).fill(255) };
  assert.deepEqual(await ocrPage(models(fakeRec()), blank), { lines: [], text: '' });
});

test('a recogniser whose classes do not fit the dictionary is refused', async () => {
  await assert.rejects(ocrPage(models(fakeRec({ classes: VOCAB.length + 1 })), page()), e => e.code === 'model-mismatch');
});

// ── the task implementation, with a stand-in ONNX Runtime ───────────────────

globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

function fakeContext({ classes = VOCAB.length, failCreate = false, test: hooks = null } = {}) {
  const det = fakeDet(), rec = fakeRec({ classes });
  const ort = {
    Tensor,
    env: { versions: { web: '1.30.0', common: '1.30.0' } },
    InferenceSession: {
      async create(bytes) {
        const tag = bytes[0];
        if (failCreate || bytes.length !== 1 || (tag !== 1 && tag !== 2)) throw new Error('not a model');
        return tag === 1 ? det : rec;
      },
    },
  };
  const files = { 'det:inference.onnx': new Uint8Array([1]), 'rec:inference.onnx': new Uint8Array([2]), 'det:inference.yml': DET_YML, 'rec:inference.yml': REC_YML };
  const reports = [];
  return {
    ctx: {
      device: 'wasm', test: hooks,
      ort: async () => ort,
      bytes: async ref => files[ref].buffer,
      text: async ref => files[ref],
      report: s => reports.push(s),
    },
    reports, det, rec,
  };
}

test('task: load reads both models and both settings files; run gives text, lines, size and backend', async () => {
  const impl = await import('../../sdk/ocr/impl.js');
  assert.equal(impl.task, 'ocr');
  const { ctx, reports } = fakeContext();
  const state = await impl.load(ctx);
  const p = page();
  const out = await impl.run(state, new ImageData(p.data, p.width, p.height), {}, ctx);
  assert.deepEqual(out.transfer, []);
  assert.equal(out.value.text, 'hola mundo\nsí');
  assert.deepEqual([out.value.width, out.value.height, out.value.device], [800, 400, 'wasm']);
  assert.ok(reports.includes('running') && reports.includes('done') && reports.includes('loading'));
  await impl.dispose(state);
});

test('task: a recogniser that does not fit, a failed load, a failed run, a bad option', async () => {
  const impl = await import('../../sdk/ocr/impl.js');
  await assert.rejects(impl.load(fakeContext({ classes: 7 }).ctx), e => e.code === 'model-mismatch');
  await assert.rejects(impl.load(fakeContext({ test: { failLoad: true } }).ctx), /not a model/);
  const { ctx } = fakeContext();
  const state = await impl.load(ctx);
  const p = page();
  await assert.rejects(impl.run(state, new ImageData(p.data, p.width, p.height), { test: { failRun: true } }, ctx), /impossible input shape/);
  await assert.rejects(impl.run(state, new ImageData(p.data, p.width, p.height), { minScore: 2 }, ctx), e => e.code === 'run-failed');
  await assert.rejects(impl.run(state, 'not an image', {}, ctx), e => e.code === 'unsupported-format');
});
