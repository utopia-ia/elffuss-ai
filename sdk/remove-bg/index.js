// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Remove the background of an image in the browser: a PNG with transparency at
// the size of the input, and its mask. The model is BEN2 (MIT, by PramaLLC),
// downloaded the first time from its pinned Hugging Face repository through the
// Elffuss model store, and kept in this browser; it runs in a Worker, on
// WebAssembly.
//
//   import { RemoveBg, removeBg } from '@elffuss/ai/remove-bg'
//   const remover = new RemoveBg({ onProgress })
//   const { png, alpha, width, height, device } = await remover.run(file)
//   await remover.dispose()
//   const { png: one } = await removeBg(file)      // load, run once, release

import { Task, oneShot } from '../core/task.js';
import { MAX_SIDE as LIMIT } from './mask.js';

/**
 * What a run gives.
 * @typedef {{ png: Blob, width: number, height: number, alpha: Uint8Array, device: 'webgpu'|'wasm',
 *   scaled: boolean, sourceWidth: number, sourceHeight: number, coverage: number }} RemoveBgResult
 *   `png` is the image with the background made transparent, `width` × `height` pixels: the input's
 *   size, or the scaled-down size when the input was larger than `maxSide` (`scaled` true, the input's
 *   own size in `sourceWidth` × `sourceHeight`). `alpha` is the PNG's alpha channel, one byte per
 *   pixel, row by row. `coverage` is the share of pixels kept (alpha of 128 or more), from 0 to 1.
 */

/** Longest side processed: a larger image is scaled down to it first, and the result says so. */
export const MAX_SIDE = LIMIT;

/**
 * Background removal with BEN2. Loads once (concurrent calls share the load),
 * runs one image after another, and runs the model in a Worker that is replaced
 * after any failure. Options: `device` ('auto' or 'wasm'; the model declares no
 * WebGPU variant, so 'webgpu' fails with `device-unsupported`), `onProgress`,
 * `signal`, and the store and registry overrides of `TaskOptions`.
 *
 *     import { RemoveBg } from '@elffuss/ai/remove-bg'
 *     const remover = new RemoveBg({ onProgress: p => console.log(p.status, p.loaded, p.total) })
 *     const { png, width, height, alpha, device } = await remover.run(file)
 *     img.src = URL.createObjectURL(png)       // same size as the file, transparent background
 *     await remover.dispose()
 * @extends Task
 */
export class RemoveBg extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) {
    super({ task: 'remove-bg', workerUrl: new URL('./worker.js', import.meta.url), impl: () => import('./impl.js') }, options);
  }

  /**
   * Remove the background of one image. Accepts a Blob or File (PNG, JPEG, GIF,
   * WebP, BMP or AVIF, by its first bytes), an ImageBitmap, an ImageData, or an
   * image, canvas or video element (turned into an ImageBitmap here). EXIF
   * orientation is applied. Fails with `decode-failed`, `unsupported-format`,
   * `too-large` (a picture over the pixel budget), `out-of-memory` (this browser
   * cannot give the model the heap it needs; checked before the download),
   * `aborted` or `run-failed`.
   * @param {Blob|ImageBitmap|ImageData|HTMLImageElement|HTMLCanvasElement} input
   * @param {{ signal?: AbortSignal, maxSide?: number }} [opts] `maxSide` lowers MAX_SIDE for this run
   * @returns {Promise<RemoveBgResult>}
   */
  run(input, opts) {
    return super.run(input, opts);
  }
}

/**
 * Load the model, remove the background of one image, and release the model.
 * Takes the options of RemoveBg and of its run in one object.
 * @type {(input: Blob|ImageBitmap|ImageData|HTMLImageElement|HTMLCanvasElement, options?: import('../core/task.js').TaskOptions & { maxSide?: number }) => Promise<RemoveBgResult>}
 */
export const removeBg = oneShot(RemoveBg);
