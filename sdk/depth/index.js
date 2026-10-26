// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Depth maps of photos in the browser, with Depth Anything V2 Small
// (depth-anything, Apache-2.0) on WebGPU or WebAssembly. The model comes from
// its original Hugging Face repository at the pinned revision, through the
// Elffuss model store. The depth is relative: 1 is the nearest point of the
// photo and 0 the farthest; it orders near and far, it does not measure
// distances.

import { Task, oneShot } from '../core/task.js';

export { normalizeDepth, depthToGrey, rampColor, colorizeDepth, RAMP_STEPS } from './maps.js';
export { encodeDepthPng16, decodePng } from './png.js';

/**
 * Depth map of a photo. Runs in a Worker; the first `load()` or `run()` asks
 * the model store for the files of the variant this browser can run (WebGPU
 * fp16 with shader-f16, WebGPU fp32 without it, WebAssembly q8 without
 * WebGPU) and checks their hashes.
 *
 * ```js
 * import { Depth, colorizeDepth, encodeDepthPng16 } from '@elffuss/ai/depth';
 *
 * const estimator = new Depth({ device: 'auto', onProgress: p => console.log(p.status) });
 * const { png, width, height, depth, device } = await estimator.run(file);
 * const pixels = colorizeDepth(depth, ramp);            // ramp: two or more [r, g, b], far first
 * const precise = await encodeDepthPng16(depth, width, height);
 * await estimator.dispose();
 * ```
 *
 * `run(input, { signal, maxSide })` takes a `Blob` or `File`, an `ImageBitmap`
 * or an `ImageData` (images and canvases are turned into an `ImageBitmap`
 * first), applies the EXIF orientation, scales photos whose longest side is
 * above `maxSide` (2048) down to it, and resolves to a `DepthResult`.
 * `load()`, `run()`, `dispose()`, `.device`, `.dtype` and `.info` come from
 * `Task` (see core); a failed run replaces the Worker, and the next run loads
 * the model again from the store without downloading it.
 * @extends Task
 */
export class Depth extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) {
    super({ task: 'depth', workerUrl: new URL('./worker.js', import.meta.url), impl: () => import('./impl.js') }, options);
  }
}

/**
 * Load, run once and dispose: `await depth(file, { device: 'wasm' })`. The
 * options of the constructor and of `run()` go together in the second argument.
 * @type {(input: Blob|ImageBitmap|ImageData, options?: import('../core/task.js').TaskOptions & { maxSide?: number }) => Promise<DepthResult>}
 */
export const depth = oneShot(Depth);

/**
 * @typedef {{ png: Blob, width: number, height: number, depth: Float32Array, device: 'webgpu'|'wasm', dtype: string,
 *   scaled: boolean, sourceWidth: number, sourceHeight: number }} DepthResult
 *   What `run()` gives: `png` is the map in grey at `width` × `height` (lighter is nearer); `depth` holds
 *   one value 0-1 per pixel, row by row (1 nearest); `scaled` is true when the photo was larger than
 *   `maxSide` and was scaled down first, from `sourceWidth` × `sourceHeight`.
 */
