// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The reading queue: every pending file, one page at a time through the
// model, in list order. While a page is being read the next one is decoded,
// so at most two decoded pages are alive at once; only text and boxes are
// kept. A file that cannot be opened or read is reported and the queue goes
// on; a page that makes the reader fail is read once more scaled down to
// 2560 pixels, and reported as too large if it fails again. A failure of the
// model store, of the model or of the runtimes stops the queue, keeping what
// was read. Pausing waits between pages; cancelling stops at once.
// No DOM here: documents and the reader are passed in.

/** Codes that stop the whole queue: nothing another file could change. */
export const STOP_CODES = new Set(['aborted', 'store-unavailable', 'store-permission', 'store-quota', 'store-network', 'integrity',
  'not-in-registry', 'device-unsupported', 'webgpu-unavailable', 'runtime-mismatch', 'model-mismatch', 'disposed']);
/** Codes of a file itself. */
export const INPUT_CODES = new Set(['decode-failed', 'unsupported-format', 'too-large']);

export const MAX_SIDE = 4000;
export const RETRY_SIDE = 2560;

const codeOf = err => (err && typeof err.code === 'string' ? err.code : 'run-failed');
const aborted = () => Object.assign(new Error('cancelled'), { code: 'aborted' });

/**
 * Pages of the pending items (items added while reading are reached too), each
 * document opened when it is reached and closed after its last page.
 * @param {object[]} items
 * @param {(item: object) => Promise<{ pages: number, page: Function, close?: Function }>} open
 */
export async function* pageStream(items, open) {
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    if (item.status !== 'pending') continue;
    let doc;
    try { doc = await open(item); } catch (error) { yield { item, error }; continue; }
    try {
      if (!(doc.pages > 0)) { yield { item, error: Object.assign(new Error('no pages'), { code: 'decode-failed' }) }; continue; }
      for (let i = 0; i < doc.pages; i++) yield { item, doc, index: i, count: doc.pages };
    } finally {
      await doc.close?.();
    }
  }
}

/**
 * Read the queue.
 * @param {object[]} items the list; items with status `pending` are read and updated in place
 * @param {{ open: (item: object) => Promise<object>,
 *   read: (input: Blob|ImageData, opts: { signal: AbortSignal, maxSide: number }) => Promise<{ text: string, lines: object[], width: number, height: number, device: string }>,
 *   onProgress?: (p: { file: number, files: number, page: number, pages: number, item: object }) => void, onItem?: (item: object) => void }} deps
 * @param {{ signal: AbortSignal, paused?: () => Promise<void>, maxSide?: number, retrySide?: number }} control
 * @returns {Promise<{ stopped: Error|null }>} `stopped` is the error that stopped the queue, if one did
 */
export async function readQueue(items, { open, read, onProgress, onItem }, { signal, paused = async () => {}, maxSide = MAX_SIDE, retrySide = RETRY_SIDE }) {
  let done = 0;
  const left = () => items.filter(i => i.status === 'pending' || i.status === 'running').length;
  let stream = pageStream(items, open);
  const pull = async () => {
    const r = await stream.next();
    if (r.done) return null;
    const e = r.value;
    if (e.error) return { e };
    const decoded = e.doc.page(e.index);
    decoded.catch(() => {});
    return { e, decoded };
  };
  let next = pull();
  next.catch(() => {});
  let current = null;
  try {
    for (;;) {
      await paused();
      if (signal.aborted) throw aborted();
      current = await next;
      if (!current) {
        // Files added after the stream passed the end of the list.
        if (!items.some(i => i.status === 'pending')) break;
        stream = pageStream(items, open);
        next = pull();
        next.catch(() => {});
        continue;
      }
      const { e } = current;
      const item = e.item;
      if (item.status === 'pending') { item.status = 'running'; item.pages = []; }
      if (e.error) {
        failItem(item, e.error);
        done++;
        onItem?.(item);
        next = pull();
        next.catch(() => {});
        continue;
      }
      onProgress?.({ file: done + 1, files: done + left(), page: e.index + 1, pages: e.count, item });
      let page = null;
      try {
        page = await current.decoded;
      } catch (err) {
        if (STOP_CODES.has(codeOf(err))) throw err;
        item.pages.push({ page: e.index + 1, error: INPUT_CODES.has(codeOf(err)) ? codeOf(err) : 'decode-failed' });
      }
      next = pull();
      next.catch(() => {});
      if (page) item.pages.push(await readPage(item, e.index + 1, page.input, { read, signal, maxSide, retrySide }));
      if (e.index === e.count - 1) {
        finishItem(item);
        done++;
        onItem?.(item);
      }
    }
    return { stopped: null };
  } catch (err) {
    const it = current?.e?.item;
    if (it?.status === 'running') {
      // A file stopped halfway is left as not read.
      it.status = 'pending';
      delete it.pages;
      delete it.device;
    }
    return { stopped: err };
  } finally {
    await stream.return?.();
  }
}

async function readPage(item, n, input, { read, signal, maxSide, retrySide }) {
  try {
    return pageResult(n, item, await read(input, { signal, maxSide }));
  } catch (err) {
    const code = codeOf(err);
    if (STOP_CODES.has(code)) throw err;
    if (code === 'decode-failed' || code === 'unsupported-format') return { page: n, error: code };
  }
  // The reader failed on this page: once more, smaller.
  try {
    return pageResult(n, item, await read(input, { signal, maxSide: retrySide }));
  } catch (err) {
    const code = codeOf(err);
    if (STOP_CODES.has(code)) throw err;
    return { page: n, error: code === 'decode-failed' || code === 'unsupported-format' ? code : 'too-large' };
  }
}

/** One page's result (the reader gives boxes in the page's own pixels). */
export function pageResult(n, item, r) {
  item.device = r.device;
  const lines = r.lines.map(l => ({ text: l.text, score: l.score, box: { ...l.box }, polygon: l.polygon.map(p => [p[0], p[1]]) }));
  return { page: n, width: r.width, height: r.height, text: r.text, lines };
}

function failItem(item, error) {
  const code = codeOf(error);
  if (code === 'unsupported-format' || code === 'pdf-password') { item.status = 'skipped'; item.reason = code; }
  else { item.status = 'error'; item.error = INPUT_CODES.has(code) ? code : 'decode-failed'; }
  delete item.pages;
}

function finishItem(item) {
  if (item.pages.some(p => !p.error)) { item.status = 'ok'; return; }
  const code = item.pages[0]?.error || 'decode-failed';
  delete item.pages;
  if (code === 'unsupported-format') { item.status = 'skipped'; item.reason = code; return; }
  item.status = 'error';
  item.error = code;
}
