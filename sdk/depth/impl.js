// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The depth task where the model runs (a Worker, or the page with worker: false).
// Depth Anything V2 Small through the Transformers.js depth-estimation pipeline,
// fed only by the model store at the pinned commit (ctx.pipeline()). The
// pipeline resizes the photo to the model's input (518 on the short side, in
// multiples of 14) and interpolates its prediction back to the photo's size;
// here the prediction is scaled to 0-1 and painted as a grey PNG.
//
// The backends follow what runonweb.ai (MIT) reports from testing them: q8
// weights give wrong outputs on WebGPU, so WebGPU uses fp16 (only where the
// adapter has shader-f16) or fp32, and WebAssembly uses q8. That choice lives
// in the registry; no code is taken from runonweb here.

import { AiError } from '../core/errors.js';
import { decodeImage, encodePng } from '../core/image-input.js';
import { normalizeDepth, depthToGrey } from './maps.js';

export const task = 'depth';

// Longest side the photo is scaled down to before running: the model works at
// about 518 pixels, so a larger map only interpolates, and it keeps the
// buffers of the run small. A caller may pass another `maxSide`.
export const MAX_SIDE = 2048;

export async function load(ctx) {
  const tf = await ctx.transformers();
  const pipe = await ctx.pipeline();
  if (ctx.test?.failLoad) {
    try { await pipe.dispose?.(); } catch { /* releasing */ }
    throw new AiError('run-failed', 'test hook: the load fails after the pipeline exists');
  }
  return { tf, pipe };
}

export async function run(state, input, opts = {}, ctx) {
  if (opts.test?.failRun) {
    // Test builds only: an input of an impossible shape, inside the runtime.
    await state.pipe.model({ pixel_values: new state.tf.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
  }
  const maxSide = Number.isFinite(opts.maxSide) && opts.maxSide >= 14 ? Math.floor(opts.maxSide) : MAX_SIDE;
  const img = await decodeImage(input, { maxSide });
  ctx.report('running');
  const out = await state.pipe(new state.tf.RawImage(img.data, img.width, img.height, 4));
  let pred = out?.predicted_depth;
  const dims = pred?.dims?.slice(-2) || [];
  if (dims[0] !== img.height || dims[1] !== img.width) {
    throw new AiError('model-mismatch', `the depth map is ${dims.join('×')}, the image ${img.height}×${img.width}`);
  }
  if (pred.type !== 'float32') pred = pred.to('float32');
  const { depth } = normalizeDepth(pred.data);
  const png = await encodePng({ width: img.width, height: img.height, data: depthToGrey(depth) });
  ctx.report('done');
  return {
    value: {
      png, width: img.width, height: img.height, depth, device: ctx.device, dtype: ctx.dtype,
      scaled: img.scaled, sourceWidth: img.sourceWidth, sourceHeight: img.sourceHeight,
    },
    transfer: [depth.buffer],
  };
}

export async function dispose(state) {
  await state?.pipe?.dispose?.();
}
