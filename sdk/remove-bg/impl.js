// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Background removal where the model runs (a Worker). The context builds BEN2's
// Transformers.js pipeline from the model store; this module feeds its model
// directly, with the input and the mask computed in mask.js rather than by the
// pipeline's own canvas resizes, so the result is the same on every browser and
// backend and the maths are tested in Node.
//
// Backend lessons, from runonweb (packages/runonweb/src/remove-bg/index.ts:4-21,
// README "What we learned testing backends"): BEN2's only ONNX weight is fp16;
// on WebGPU it loads and then its first run fails in the fused LayerNorm (fp16
// activation with fp32 scale and bias), with ONNX Runtime Web 1.30.0 as with
// 1.31.0-dev (onnxruntime#32627). The registry therefore lists WebAssembly
// only; the browser tests keep a canary that runs it on WebGPU anyway.

import { AiError, toAiError } from '../core/errors.js';
import { decodeImage, encodePng } from '../core/image-input.js';
import { inputSpec, toModelInput, maskToAlpha, applyAlpha, coverage, sideLimit } from './mask.js';

export const task = 'remove-bg';

// Create the pipeline (through the context: model store, pinned commit, checked
// files and runtimes) and read what the model takes.
export async function load(ctx) {
  const tf = await ctx.transformers();
  const pipe = await ctx.pipeline();
  if (ctx.test?.failLoad) throw new AiError('run-failed', 'test hook: the load fails on purpose');
  const spec = inputSpec(pipe.processor?.image_processor ?? pipe.processor?.feature_extractor);
  const session = pipe.model?.sessions?.model;
  const inputName = session?.inputNames?.[0];
  const outputName = session?.outputNames?.[0];
  if (!inputName || !outputName) throw new AiError('model-mismatch', 'the model has no input or no output');
  return { tf, pipe, spec, inputName, outputName };
}

// The mask of a model output, checked against the size the model takes.
function maskOf(tensor, { width, height }) {
  const dims = tensor?.dims || [];
  const data = tensor?.data;
  const ok = dims.length >= 2 && dims.at(-1) === width && dims.at(-2) === height && data?.length === width * height;
  if (!ok) throw new AiError('model-mismatch', `the model gave a mask of shape [${dims.join(', ')}], not ${width}×${height}`);
  return data;
}

// Remove the background of one image (a Blob, ImageBitmap or ImageData; see
// RemoveBg.run in index.js for what it gives).
export async function run(state, input, opts = {}, ctx) {
  const { tf, pipe, spec, inputName, outputName } = state;
  if (opts.test?.failRun) {
    // Test builds: an input of an impossible shape, refused inside the runtime.
    await pipe.model({ [inputName]: new tf.Tensor('float32', new Float32Array(3), [1, 3, 1, 1]) });
  }
  const img = await decodeImage(input, { maxSide: sideLimit(opts.maxSide) });
  // An ImageData that needed no scaling comes back as is: never write into the caller's pixels.
  const rgba = typeof ImageData !== 'undefined' && input instanceof ImageData && img.data === input.data ? new Uint8ClampedArray(img.data) : img.data;
  ctx.report('running');
  try {
    const pixels = toModelInput({ data: rgba, width: img.width, height: img.height }, spec);
    const out = await pipe.model({ [inputName]: new tf.Tensor('float32', pixels, [1, 3, spec.height, spec.width]) });
    const mask = maskOf(out[outputName], spec);
    const alpha = maskToAlpha(mask, spec.width, spec.height, img.width, img.height);
    for (const t of Object.values(out)) t?.dispose?.();
    applyAlpha(rgba, alpha);
    const png = await encodePng({ width: img.width, height: img.height, data: rgba });
    ctx.report('done');
    return {
      value: {
        png, width: img.width, height: img.height, alpha, device: ctx.device,
        scaled: img.scaled, sourceWidth: img.sourceWidth, sourceHeight: img.sourceHeight, coverage: coverage(alpha),
      },
      transfer: [alpha.buffer],
    };
  } catch (err) {
    if (err instanceof RangeError) throw new AiError('too-large', 'the image is too large to process here', { cause: err, details: { width: img.width, height: img.height } });
    throw toAiError(err, 'run-failed');
  }
}

// Release the pipeline's sessions.
export async function dispose(state) {
  await state?.pipe?.dispose?.();
}
