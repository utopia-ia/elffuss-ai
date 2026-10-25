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
    const feeds = { [s.inputNames[0]]: new state.ort.Tensor('float32', new Float32Array(dims.reduce((a, b) => a * b, 1)), dims) };
    const r = await s.run(feeds);
    outputs[ref] = Object.fromEntries(Object.entries(r).map(([k, t]) => [k, dimsOf(t)]));
  }
  ctx.report('done');
  return { value: { kind: 'ort', outputs } };
}

export async function dispose(state) {
  if (state?.kind === 'tf') await state.pipe?.dispose?.();
  if (state?.kind === 'ort') for (const s of Object.values(state.sessions)) { try { await s.release(); } catch { /* gone */ } }
}
