// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Images in and out of a task. On the page, anything image-like becomes what a
// Worker can receive without copying (Blob, ImageBitmap, ImageData). In the
// Worker, a Blob is sniffed by its first bytes (never by its name), decoded with
// its EXIF orientation applied, and scaled down when it is too large.

import { AiError } from './errors.js';

/** Image types the tasks decode, by their first bytes. */
export function sniffImageType(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head);
  const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
  const ascii = (i, s) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(0, 'BM')) return 'image/bmp';
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.subarray(8, 12));
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
  if (ascii(0, '%PDF-')) return 'application/pdf';
  return null;
}

/** Types the browser decodes for the tasks. HEIC and TIFF are refused on purpose. */
export const DECODABLE = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

/**
 * On the page: turn an image-like input into something a Worker takes without
 * copying. Returns the value and the list of objects to transfer.
 * @param {Blob|ImageBitmap|ImageData|HTMLImageElement|HTMLCanvasElement|OffscreenCanvas|HTMLVideoElement|VideoFrame} input
 * @returns {Promise<{ value: Blob|ImageBitmap|ImageData, transfer: Transferable[] }>}
 */
export async function toTransferable(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return { value: input, transfer: [] };
  if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) return { value: input, transfer: [input] };
  if (typeof ImageData !== 'undefined' && input instanceof ImageData) return { value: input, transfer: [] };
  if (input && typeof input === 'object' && ('naturalWidth' in input || 'videoWidth' in input || 'getContext' in input || 'displayWidth' in input)) {
    try {
      const bmp = await createImageBitmap(input);
      return { value: bmp, transfer: [bmp] };
    } catch (err) {
      throw new AiError('decode-failed', 'the image could not be read', { cause: err });
    }
  }
  throw new AiError('unsupported-format', 'not an image');
}

/**
 * In the Worker (or the page): decode an input to RGBA pixels.
 * @param {Blob|ImageBitmap|ImageData} input
 * @param {{ maxSide?: number, close?: boolean }} [opts] `maxSide` scales the longest side down to it
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray, scaled: boolean, sourceWidth: number, sourceHeight: number }>}
 */
export async function decodeImage(input, { maxSide = 0, close = true } = {}) {
  let source = input;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size === 0) throw new AiError('decode-failed', 'the file is empty');
    const type = sniffImageType(new Uint8Array(await input.slice(0, 32).arrayBuffer()));
    if (!type) throw new AiError('unsupported-format', 'not an image this site reads');
    if (!DECODABLE.includes(type)) throw new AiError('unsupported-format', `${type} is not supported`, { details: { type } });
    try { source = await createImageBitmap(input, { imageOrientation: 'from-image' }); }
    catch (err) { throw new AiError('decode-failed', 'the image could not be decoded', { cause: err, details: { type } }); }
  } else if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
    const { width, height } = input;
    if (!maxSide || Math.max(width, height) <= maxSide) return { width, height, data: input.data, scaled: false, sourceWidth: width, sourceHeight: height };
    source = await createImageBitmap(input);
  } else if (!(typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap)) {
    throw new AiError('unsupported-format', 'not an image');
  }
  const sw = source.width, sh = source.height;
  if (!sw || !sh) throw new AiError('decode-failed', 'the image has no pixels');
  const k = maxSide && Math.max(sw, sh) > maxSide ? maxSide / Math.max(sw, sh) : 1;
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  if (close && source !== input) source.close?.();
  else if (close && typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) input.close();
  return { width: w, height: h, data, scaled: k !== 1, sourceWidth: sw, sourceHeight: sh };
}

/**
 * Encode RGBA pixels as PNG (needs OffscreenCanvas, so a browser realm).
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} img
 * @returns {Promise<Blob>}
 */
export async function encodePng({ width, height, data }) {
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
