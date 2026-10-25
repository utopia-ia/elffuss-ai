// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// PDF files, page by page, with the vendored PDF.js from this site's origin:
// its library on the page, its Worker created through the Trusted Types
// policy, and its decoders, character maps, standard fonts and colour profile
// fetched from /vendor/. One document open at a time; each page is drawn at
// 200 dpi (less when its longest side would pass 4000 pixels), handed over as
// ImageData and its canvas released at once. The text a digital PDF
// already carries is not used: every page is read like a scan.

import { scriptUrl } from './sdk/core/tt.js';
import { assertPdfjsRuntime } from './sdk/core/runtimes.js';

/** Resolution of the rendered pages. */
export const PDF_DPI = 200;

const coded = (code, message, cause) => Object.assign(new Error(message), { code, cause });

/**
 * Scale and pixel size of a page of `widthPt × heightPt` points.
 * @returns {{ scale: number, width: number, height: number }}
 */
export function pageSize(widthPt, heightPt, maxSide = 4000) {
  const scale = Math.min(PDF_DPI / 72, maxSide / Math.max(widthPt, heightPt));
  return { scale, width: Math.max(1, Math.floor(widthPt * scale)), height: Math.max(1, Math.floor(heightPt * scale)) };
}

let lib = null;

/**
 * PDF.js of this site, checked against its pin, with its Worker (once per page).
 * @param {{ lib: string, worker: string }} runtime same-origin URLs
 */
export function loadPdfjs(runtime) {
  if (!lib) {
    lib = (async () => {
      const m = await import(new URL(runtime.lib, location.href).href);
      assertPdfjsRuntime(m);
      const worker = new Worker(scriptUrl(new URL(runtime.worker, location.href).href), { type: 'module', name: 'pdfjs' });
      m.GlobalWorkerOptions.workerPort = worker;
      return m;
    })();
    lib.catch(() => { lib = null; });
  }
  return lib;
}

/**
 * Open a PDF file.
 * @param {Blob} file
 * @param {{ lib: string, worker: string, wasmUrl: string, cMapUrl: string, standardFontDataUrl: string, iccUrl: string }} runtime
 * @returns {Promise<{ pages: number, page(i: number, maxSide?: number): Promise<{ data: ImageData, width: number, height: number }>, close(): Promise<void> }>}
 */
export async function openPdf(file, runtime) {
  const pdfjs = await loadPdfjs(runtime);
  const abs = u => new URL(u, location.href).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    wasmUrl: abs(runtime.wasmUrl),
    iccUrl: abs(runtime.iccUrl),
    cMapUrl: abs(runtime.cMapUrl),
    cMapPacked: true,
    standardFontDataUrl: abs(runtime.standardFontDataUrl),
    useSystemFonts: false,
    enableXfa: false,
    enableHWA: false,
    maxImageSize: 8192 * 8192,
    canvasMaxAreaInBytes: 8192 * 8192 * 4,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy?.().catch?.(() => {});
    if (err?.name === 'PasswordException') throw coded('pdf-password', 'the PDF file has a password', err);
    throw coded('decode-failed', 'the PDF file could not be opened', err);
  }
  return {
    pages: doc.numPages,
    async page(i, maxSide = 4000) {
      const page = await doc.getPage(i + 1);
      try {
        const base = page.getViewport({ scale: 1 });
        const size = pageSize(base.width, base.height, maxSide);
        const viewport = page.getViewport({ scale: size.scale });
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        try {
          await page.render({ canvas, viewport, intent: 'print' }).promise;
          const data = canvas.getContext('2d').getImageData(0, 0, size.width, size.height);
          return { data, width: size.width, height: size.height };
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      } catch (err) {
        throw err?.code ? err : coded('decode-failed', 'a page of the PDF file could not be drawn', err);
      } finally {
        page.cleanup();
      }
    },
    async close() {
      try { await doc.destroy(); } catch { /* already gone */ }
    },
  };
}
