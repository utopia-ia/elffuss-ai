// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Background removal where the model runs (a Worker). The context builds BEN2's
// Transformers.js pipeline from the model store; this module feeds its model
// directly, with the input and the mask computed in mask.js rather than by the
// pipeline's own canvas resizes, so the result is the same on every browser and
// backend and the maths are tested in Node.
//
// Backend lessons. runonweb found (packages/runonweb/src/remove-bg/index.ts:4-21,
// README "What we learned testing backends") that BEN2, whose only ONNX weight
// is fp16, loads on WebGPU and then fails at its first run in the fused
// LayerNorm (fp16 activation with fp32 scale and bias), with ONNX Runtime Web
// 1.30.0 as with 1.31.0-dev (onnxruntime#32627). With the pinned 1.30.0 our own
// canary also sees the first run fail inside OrtRun on WebGPU, but in a WebGPU
// buffer allocation, so the cause is not settled; either way the registry lists
// WebAssembly only, and the browser tests keep the canary, which records the
// error it gets, to learn when an upgrade makes it run.
//
// Its size. At 1024 × 1024 BEN2 needs a WebAssembly heap of about 3.5 GiB: with
// 3 GiB every run fails inside OrtRun with std::bad_alloc. Before anything is
// downloaded, load() checks that this browser can give it that (and, where the
// browser says how much the device has, that it is not a small device), and
// says out-of-memory if not; an allocation that fails later says the same.

import { AiError, toAiError } from '../core/errors.js';
import { decodeImage, encodePng } from '../core/image-input.js';
import { canGrowWasmMemory } from '../core/device.js';
import { inputSpec, toModelInput, maskToAlpha, applyAlpha, coverage, sideLimit } from './mask.js';

export const task = 'remove-bg';

/** The WebAssembly heap one run of BEN2 needs, in bytes (measured: 3 GiB is not enough). */
export const WASM_HEAP = 3.5 * 2 ** 30;
/** The least `navigator.deviceMemory` (in GiB, as browsers round it) a device needs for it. */
export const MIN_DEVICE_GIB = 4;

/**
 * Whether this browser can run BEN2, before downloading it: the WebAssembly heap
 * can grow to WASM_HEAP, and the device is not one that says it has less than
 * MIN_DEVICE_GIB. Throws out-of-memory when not.
 * @param {{ deviceMemory?: number }} [nav]
 */
export function checkCanRun(nav = globalThis.navigator) {
  const gib = Number(nav?.deviceMemory);
  if (Number.isFinite(gib) && gib > 0 && gib < MIN_DEVICE_GIB) {
    throw new AiError('out-of-memory', `this device says it has ${gib} GiB; the model needs more`, { details: { deviceMemory: gib } });
  }
  if (!canGrowWasmMemory(WASM_HEAP)) throw new AiError('out-of-memory', 'this browser cannot give WebAssembly the heap the model needs', { details: { heap: WASM_HEAP } });
}

// Create the pipeline (through the context: model store, pinned commit, checked
// files and runtimes) and read what the model takes. Nothing is downloaded when
// this browser cannot run the model.
export async function load(ctx) {
  if (ctx.device === 'wasm') checkCanRun();
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
    // An allocation that fails inside the runtime or for the result is out-of-memory
    // (toAiError recognises it); the Worker is replaced, as after any runtime failure.
    throw toAiError(err, 'run-failed');
  }
}

// Release the pipeline's sessions.
export async function dispose(state) {
  await state?.pipe?.dispose?.();
}
