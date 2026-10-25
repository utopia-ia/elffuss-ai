// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Every kind of file as a document of pages, each page an input the reader
// takes as it is: an image file goes to the task's Worker untouched (it is
// decoded there, with its EXIF orientation); a TIFF or PDF page is decoded
// here, one at a time, into ImageData. Neither is transferred, so a second
// attempt (on WebAssembly, or scaled down) reads the same input again. A HEIC
// image is decoded here only where the browser can open it.

import { openPdf } from './pdf.js';
import { tiffPages, decodeTiffPage } from './tiff.js';

const coded = (code, message, cause) => Object.assign(new Error(message), { code, cause });

/** Pixels of a bitmap, through a canvas the size of the bitmap. */
export function pixelsOf(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/** Decode JPEG bytes (inside a TIFF file) with the browser. */
export async function decodeJpeg(bytes) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  try { return pixelsOf(bmp); } finally { bmp.close(); }
}

function imageDocument(item) {
  return { pages: 1, async page() { return { input: item.file }; }, close() {} };
}

function heicDocument(item) {
  return {
    pages: 1,
    async page() {
      let bmp;
      try { bmp = await createImageBitmap(item.file, { imageOrientation: 'from-image' }); }
      catch (err) { throw coded('unsupported-format', 'this browser does not open HEIC images', err); }
      try { return { input: pixelsOf(bmp) }; } finally { bmp.close(); }
    },
    close() {},
  };
}

async function tiffDocument(item) {
  const bytes = new Uint8Array(await item.file.arrayBuffer());
  const { pages } = tiffPages(bytes);
  return {
    pages: pages.length,
    async page(i) {
      const img = await decodeTiffPage(bytes, pages[i], { decodeJpeg });
      return { input: new ImageData(img.data, img.width, img.height) };
    },
    close() {},
  };
}

async function pdfDocument(item, runtime) {
  const doc = await openPdf(item.file, runtime);
  return {
    pages: doc.pages,
    async page(i) {
      return { input: (await doc.page(i)).data };
    },
    close: () => doc.close(),
  };
}

/**
 * Open one item of the list as a document of pages.
 * @param {{ kind: string, file: Blob }} item
 * @param {{ pdfjs: object }} runtime the site's runtime URLs
 */
export async function openDocument(item, runtime) {
  try {
    if (item.kind === 'image') return imageDocument(item);
    if (item.kind === 'heic') return heicDocument(item);
    if (item.kind === 'tiff') return await tiffDocument(item);
    if (item.kind === 'pdf') return await pdfDocument(item, runtime.pdfjs);
  } catch (err) {
    throw err?.code ? err : coded('decode-failed', 'the file could not be opened', err);
  }
  throw coded('unsupported-format', 'not a format this site reads');
}
