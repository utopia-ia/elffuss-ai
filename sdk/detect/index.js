// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// @elffuss/ai/detect: finds objects of 80 everyday kinds (the COCO classes:
// people, vehicles, animals, furniture, food…) in a photo or a video frame, with
// RF-DETR Nano, in the browser. Each object comes with its class name in English,
// a score from 0 to 1 and its box in pixels of the image.
//
//   import { Detect, detect } from '@elffuss/ai/detect'
//   const detector = new Detect({ onProgress })
//   const { objects } = await detector.run(file, { threshold: 0.5 })
//   // [{ label: 'dog', score: 0.94, box: { xmin, ymin, xmax, ymax } }, …]
//   await detector.dispose()
//
//   const { objects: once } = await detect(file)    // load, run once, dispose

/**
 * @typedef {{ objects: import('./decode.js').DetectedObject[], width: number, height: number, device: 'webgpu'|'wasm' }} DetectResult
 *   `width` and `height` are the size of the input image, the one the boxes are given in.
 * @typedef {{ threshold?: number, signal?: AbortSignal }} DetectRunOptions
 *   `threshold`: minimum score of an object, from 0 to 1 (0.5 by default).
 */
import { Task, oneShot } from '../core/task.js';

/** The default `threshold` of run(): 0.5. */
export { DEFAULT_THRESHOLD } from './decode.js';

/**
 * Object detection with RF-DETR Nano. One model per instance, loaded once from the
 * Elffuss model store; runs go one after another.
 * @extends Task
 */
export class Detect extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) {
    super({ task: 'detect', workerUrl: new URL('./worker.js', import.meta.url), impl: () => import('./impl.js') }, options);
  }

  /**
   * Detect the objects of one image. Loads the model first if needed.
   * The image is a Blob or File (PNG, JPEG, GIF, WebP, BMP or AVIF, recognised by
   * its first bytes), an ImageBitmap or an ImageData; an image, canvas or video
   * element is turned into an ImageBitmap on the page first.
   * @param {Blob|ImageBitmap|ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement|OffscreenCanvas|VideoFrame} input
   * @param {DetectRunOptions} [opts]
   * @returns {Promise<DetectResult>} the objects, highest score first
   */
  run(input, opts) {
    return super.run(input, opts);
  }
}

/**
 * Load, detect once and dispose: `detect(file, { threshold, device, onProgress })`.
 * Options of `new Detect()` and of `run()` can be mixed.
 * @type {(input: Blob|ImageBitmap|ImageData, options?: import('../core/task.js').TaskOptions & DetectRunOptions) => Promise<DetectResult>}
 */
export const detect = oneShot(Detect);
