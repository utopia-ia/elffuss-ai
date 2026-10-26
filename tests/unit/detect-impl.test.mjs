// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// sdk/detect/impl.js with a fake runtime: what load() keeps, how run() prepares
// the image (one high-quality resize to the processor's size, then rescaled and
// normalised with the ImageNet mean and deviation the model was trained with,
// even though its config says do_normalize: false), what it hands the model, how
// it decodes the outputs at the caller's image size, the test hooks, the errors,
// and that every tensor and bitmap it makes is released.
import test from 'node:test';
import assert from 'node:assert/strict';
import { logitOf } from '../../sdk/detect/decode.js';

// ── a browser-like realm, just enough for decodeImage(ImageData) and the resize ──
const log = { bitmaps: [], closed: 0, canvases: [] };
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
globalThis.createImageBitmap = async (source, opts = {}) => {
  log.bitmaps.push({ from: [source.width, source.height], opts });
  return { width: opts.resizeWidth ?? source.width, height: opts.resizeHeight ?? source.height, close() { log.closed++; } };
};
globalThis.OffscreenCanvas = class OffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; log.canvases.push([w, h]); }
  getContext() {
    return { drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }) };
  }
};

const impl = await import('../../sdk/detect/impl.js');

class FakeTensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; this.disposed = false; }
  dispose() { this.disposed = true; }
}
class FakeRawImage {
  constructor(data, width, height, channels) { this.data = data; this.width = width; this.height = height; this.channels = channels; }
}

/** A pipeline whose model finds a dog (class 18) and a cat (class 17), named like COCO. */
function fakePipe({ size = { height: 384, width: 384 }, outputs = true } = {}) {
  const seen = { processor: [], model: [], tensors: [], disposed: false };
  const Q = 3, C = 91;
  const processor = async images => {
    seen.processor.push(images);
    const t = new FakeTensor('float32', new Float32Array(3 * size.height * size.width), [1, 3, size.height, size.width]);
    seen.tensors.push(t);
    return { pixel_values: t };
  };
  processor.image_processor = { size, do_normalize: false, do_rescale: true, rescale_factor: 1 / 255, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225] };
  const model = async inputs => {
    seen.model.push(inputs);
    const dims = inputs.pixel_values.dims;
    if (dims[2] !== size.height || dims[3] !== size.width) throw new Error(`Got invalid dimensions for input: pixel_values (${dims})`);
    if (!outputs) return {};
    const logits = new Float32Array(Q * C).fill(-9);
    logits[0 * C + 18] = logitOf(0.92);
    logits[1 * C + 17] = logitOf(0.81);
    logits[2 * C + 17] = logitOf(0.4);
    const boxes = Float32Array.from([0.5, 0.5, 0.2, 0.4, 0.25, 0.75, 0.1, 0.2, 0.9, 0.1, 0.1, 0.1]);
    const out = { logits: new FakeTensor('float32', logits, [1, Q, C]), pred_boxes: new FakeTensor('float32', boxes, [1, Q, 4]) };
    seen.tensors.push(out.logits, out.pred_boxes);
    return out;
  };
  model.config = { model_type: 'rf_detr', id2label: { 17: 'cat', 18: 'dog', 1: 'person' } };
  return { processor, model, dispose: async () => { seen.disposed = true; }, seen };
}

function fakeCtx(pipe, { test: hooks = null, device = 'wasm' } = {}) {
  const statuses = [];
  return { statuses, device, test: hooks, transformers: async () => ({ RawImage: FakeRawImage, Tensor: FakeTensor }), pipeline: async () => pipe, report: s => statuses.push(s) };
}

const image = (w, h) => new ImageData(new Uint8ClampedArray(w * h * 4), w, h);

test('the normalisation comes from the image processor, whatever do_normalize says', () => {
  const p = { do_normalize: false, rescale_factor: 1 / 255, image_mean: [0.485, 0.456, 0.406], image_std: [0.229, 0.224, 0.225] };
  assert.deepEqual(impl.normalisation(p), { rescale: 1 / 255, mean: p.image_mean, std: p.image_std });
  assert.equal(impl.normalisation({ ...p, do_rescale: false }).rescale, 1);
  for (const bad of [{ ...p, image_mean: undefined }, { ...p, image_std: [0.2, 0, 0.2] }, { ...p, image_mean: [0.5, 0.5] }, { ...p, rescale_factor: -1 }]) {
    assert.throws(() => impl.normalisation(bad), { code: 'model-mismatch' });
  }
  const px = impl.pixelValues(Uint8Array.from([255, 0, 128, 7, 0, 255, 128, 9]), { width: 2, height: 1 }, impl.normalisation(p));
  assert.equal(px.length, 6, 'planar RGB, the alpha is not read');
  assert.ok(Math.abs(px[0] - (1 - 0.485) / 0.229) < 1e-6 && Math.abs(px[1] - (0 - 0.485) / 0.229) < 1e-6, 'red plane');
  assert.ok(Math.abs(px[4] - (128 / 255 - 0.406) / 0.225) < 1e-6, 'blue plane');
  assert.throws(() => impl.pixelValues(new Uint8Array(7), { width: 2, height: 1 }, impl.normalisation(p)), RangeError);
});

test('the task name, and the input size from the image processor', () => {
  assert.equal(impl.task, 'detect');
  assert.deepEqual(impl.inputSize({ height: 384, width: 384 }), { width: 384, height: 384 });
  assert.throws(() => impl.inputSize({ shortest_edge: 384 }), { code: 'model-mismatch' });
  assert.throws(() => impl.inputSize(undefined), { code: 'model-mismatch' });
  assert.ok(impl.DECODE_MAX_SIDE >= 1024);
});

test('load keeps the pipeline, the input size and the class names; the test hook fails it', async () => {
  const pipe = fakePipe();
  const state = await impl.load(fakeCtx(pipe));
  assert.deepEqual(state.size, { width: 384, height: 384 });
  assert.equal(state.id2label[18], 'dog');
  await assert.rejects(impl.load(fakeCtx(pipe, { test: { failLoad: true } })), /test hook/);
  const noModel = { ...pipe, model: null };
  await assert.rejects(impl.load(fakeCtx(noModel)), { code: 'model-mismatch' });
});

test('run: one high-quality resize, the normalised input, the model, boxes at the caller\'s size', async () => {
  const pipe = fakePipe();
  const ctx = fakeCtx(pipe);
  const state = await impl.load(ctx);
  log.bitmaps.length = 0; log.closed = 0;
  const out = await impl.run(state, image(200, 100), {}, ctx);
  assert.deepEqual(log.bitmaps.map(b => b.opts), [{ resizeWidth: 384, resizeHeight: 384, resizeQuality: 'high' }]);
  assert.equal(log.closed, 1, 'the resized bitmap is released');
  assert.equal(pipe.seen.processor.length, 0, 'the image processor, which would not normalise, is not used');
  assert.deepEqual(Object.keys(pipe.seen.model[0]), ['pixel_values'], 'only the input the model has');
  const input = pipe.seen.model[0].pixel_values;
  assert.deepEqual(input.dims, [1, 3, 384, 384]);
  // Every resized pixel is 200 here: (200/255 − mean) / std, channel by channel.
  const n = 384 * 384;
  const norm = [0, 1, 2].map(c => (200 / 255 - [0.485, 0.456, 0.406][c]) / [0.229, 0.224, 0.225][c]);
  for (const c of [0, 1, 2]) for (const i of [0, n - 1]) assert.ok(Math.abs(input.data[c * n + i] - norm[c]) < 1e-5, `channel ${c}: ${input.data[c * n + i]} vs ${norm[c]}`);
  assert.equal(input.disposed, true, 'the input tensor is released');
  assert.deepEqual(out.transfer, undefined);
  const v = out.value;
  assert.deepEqual([v.width, v.height, v.device], [200, 100, 'wasm']);
  assert.deepEqual(v.objects.map(o => o.label), ['dog', 'cat'], 'default threshold 0.5, highest score first');
  const want = { xmin: 80, ymin: 30, xmax: 120, ymax: 70 };
  for (const k of Object.keys(want)) assert.ok(Math.abs(v.objects[0].box[k] - want[k]) < 1e-4, `${k}: ${v.objects[0].box[k]}`);
  assert.ok(pipe.seen.tensors.every(t => t.disposed), 'output tensors are released');
  assert.deepEqual(ctx.statuses, ['running', 'done']);
});

test('run honours the threshold option and caches the class list', async () => {
  const pipe = fakePipe();
  const ctx = fakeCtx(pipe);
  const state = await impl.load(ctx);
  assert.deepEqual((await impl.run(state, image(64, 64), { threshold: 0.9 }, ctx)).value.objects.map(o => o.label), ['dog']);
  const labels = state.labels;
  assert.deepEqual((await impl.run(state, image(64, 64), { threshold: 0.3 }, ctx)).value.objects.map(o => o.label), ['dog', 'cat', 'cat']);
  assert.equal(state.labels, labels, 'the class list is built once');
  assert.deepEqual((await impl.run(state, image(64, 64), { threshold: 'x' }, ctx)).value.objects.length, 2, 'a bad threshold means the default');
});

test('run with failRun feeds the model an impossible shape before anything else', async () => {
  const pipe = fakePipe();
  const ctx = fakeCtx(pipe);
  const state = await impl.load(ctx);
  await assert.rejects(impl.run(state, image(64, 64), { test: { failRun: true } }, ctx), /invalid dimensions/);
  assert.deepEqual(pipe.seen.model[0].pixel_values.dims, [1, 3, 1, 1]);
  assert.deepEqual(ctx.statuses, []);
});

test('outputs without logits are a model-mismatch; inputs that are not images are refused', async () => {
  const pipe = fakePipe({ outputs: false });
  const ctx = fakeCtx(pipe);
  const state = await impl.load(ctx);
  await assert.rejects(impl.run(state, image(64, 64), {}, ctx), { code: 'model-mismatch' });
  assert.ok(pipe.seen.tensors.every(t => t.disposed));
  await assert.rejects(impl.run(state, { not: 'an image' }, {}, ctx), { code: 'unsupported-format' });
});

test('dispose releases the pipeline, also when called twice or without a state', async () => {
  const pipe = fakePipe();
  const state = await impl.load(fakeCtx(pipe));
  await impl.dispose(state);
  assert.equal(pipe.seen.disposed, true);
  await impl.dispose(state);
  await impl.dispose(null);
});
