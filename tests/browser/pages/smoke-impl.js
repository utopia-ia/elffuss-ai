// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Test builds only: a task implementation for any model of the registry. It
// creates what the model needs through the context (a Transformers.js pipeline,
// or one ONNX Runtime session per .onnx file) and runs it once on a synthetic
// input, returning shapes only. With the test hooks it fails on purpose: failRun
// feeds the model an input of an impossible shape (inside the runtime, which is
// what leaves Transformers.js unusable), failLoad makes the load fail.
import { decodeImage } from '../sdk/core/image-input.js';

export const task = null;

export async function load(ctx) {
  if (ctx.model.runtime === 'transformers.js') {
    const tf = await ctx.transformers();
    const pipe = await ctx.pipeline();
    if (ctx.test?.failLoad) throw new Error('test hook: the load fails after the pipeline exists');
    return { kind: 'tf', tf, pipe };
  }
  const ort = await ctx.ort();
  if (ctx.test?.failLoad) await ort.InferenceSession.create(new Uint8Array([1, 2, 3, 4]));
  const sessions = {};
  const texts = {};
  for (const f of ctx.files) {
    if (f.path.endsWith('.onnx')) sessions[f.ref] = await ctx.session(f.ref);
    else texts[f.ref] = (await ctx.text(f.ref)).length;
  }
  return { kind: 'ort', ort, sessions, texts };
}

const dimsOf = t => (t && Array.isArray(t.dims) ? t.dims : null);
const ARRAYS = { float32: Float32Array, uint8: Uint8Array, int32: Int32Array, int64: BigInt64Array };

/**
 * One zero tensor per input of a session. A session with one float input takes
 * `dims`, as before; one with several (an image and its mask, as MI-GAN takes)
 * gets each input's type and shape from the session, its free dimensions set
 * from `dims` (the batch to 1).
 */
function feedsOf(ort, s, dims) {
  const meta = Array.isArray(s.inputMetadata) && s.inputMetadata.length ? s.inputMetadata : s.inputNames.map(name => ({ name, type: 'float32', shape: dims }));
  if (meta.length === 1 && meta[0].type === 'float32') return { [meta[0].name]: new ort.Tensor('float32', new Float32Array(dims.reduce((a, b) => a * b, 1)), dims) };
  const feeds = {};
  for (const m of meta) {
    const shape = (m.shape || dims).map((d, i) => (Number.isInteger(d) && d > 0 ? d : i === 0 ? 1 : dims[i] ?? 64));
    const Arr = ARRAYS[m.type] || Float32Array;
    feeds[m.name] = new ort.Tensor(m.type in ARRAYS ? m.type : 'float32', new Arr(shape.reduce((a, b) => a * b, 1)), shape);
  }
  return feeds;
}

export async function run(state, input, opts, ctx) {
  if (opts.test?.failRun) {
    if (state.kind === 'tf') await state.pipe.model({ pixel_values: new state.tf.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
    else {
      const s = Object.values(state.sessions)[0];
      await s.run({ [s.inputNames[0]]: new state.ort.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
    }
  }
  ctx.report('running');
  if (state.kind === 'tf') {
    const img = await decodeImage(input);
    const raw = new state.tf.RawImage(img.data, img.width, img.height, 4);
    const out = await state.pipe(raw);
    let shape;
    if (Array.isArray(out) && out[0]?.width) shape = { images: out.length, width: out[0].width, height: out[0].height, channels: out[0].channels };
    else if (Array.isArray(out)) shape = { detections: out.length };
    else if (out?.depth) shape = { width: out.depth.width, height: out.depth.height, predicted: dimsOf(out.predicted_depth) };
    else shape = { keys: Object.keys(out || {}) };
    ctx.report('done');
    return { value: { kind: 'tf', input: { width: img.width, height: img.height }, shape } };
  }
  const outputs = {};
  for (const [ref, s] of Object.entries(state.sessions)) {
    const dims = ref.startsWith('rec:') ? [1, 3, 48, 160] : [1, 3, 64, 64];
    const r = await s.run(feedsOf(state.ort, s, dims));
    outputs[ref] = Object.fromEntries(Object.entries(r).map(([k, t]) => [k, dimsOf(t)]));
  }
  ctx.report('done');
  return { value: { kind: 'ort', outputs } };
}

export async function dispose(state) {
  if (state?.kind === 'tf') await state.pipe?.dispose?.();
  if (state?.kind === 'ort') for (const s of Object.values(state.sessions)) { try { await s.release(); } catch { /* gone */ } }
}
