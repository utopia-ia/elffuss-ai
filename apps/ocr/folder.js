// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The list of files to read, from every way a user gives them: the file picker,
// a folder picker (the `webkitdirectory` input, or showDirectoryPicker where the
// browser has it), dropped files and folders (subfolders included), and pasted
// images. Each entry keeps its relative path. Then each file is classified by
// its first bytes, never by its name: images, PDF, TIFF and HEIC are read;
// hidden and system files are left out without a word (they only count in the
// summary); anything else is left out as an unsupported format. Nothing is
// decoded here.

import { sniffImageType } from './sdk/core/image-input.js';

/** Most files one list can hold: the ZIP of the results has no ZIP64. */
export const MAX_FILES = 65535;
/** Above these, the page asks before reading. */
export const CONFIRM_FILES = 2000;
export const CONFIRM_BYTES = 2e9;

const SYSTEM = new Set(['thumbs.db', 'desktop.ini', 'ehthumbs.db', '__macosx']);
const READABLE_NAME = /\.(png|jpe?g|jfif|gif|webp|bmp|dib|avif|tiff?|heic|heif|pdf)$/i;

/** A relative path: NFC, forward slashes, no leading slash, no `.` or `..` segments. */
export function normalizePath(p) {
  return String(p).normalize('NFC').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..').join('/');
}

/** True for hidden and system files, and anything inside a hidden or system folder. */
export function isHidden(path) {
  return path.split('/').some(seg => seg.startsWith('.') || SYSTEM.has(seg.toLowerCase()));
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Natural order of paths, segment by segment ("2" before "10"; case only breaks ties). */
export function comparePaths(a, b) {
  const x = a.split('/'), y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = collator.compare(x[i], y[i]);
    if (c) return c;
  }
  if (x.length !== y.length) return x.length - y.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The folder every path starts with, when they all share one and each lies inside it. */
export function commonRoot(paths) {
  if (!paths.length) return null;
  const first = paths[0].split('/')[0];
  return paths.every(p => p.includes('/') && p.split('/')[0] === first) ? first : null;
}

/**
 * Entries of a picked or dropped list: the path a folder picker gives
 * (`webkitRelativePath`), or the file name.
 * @param {Iterable<File>} files
 */
export function entriesFromFiles(files) {
  return [...files].map(file => ({ path: normalizePath(file.webkitRelativePath || file.name), file }));
}

/**
 * Walk a dropped FileSystemEntry (file or folder, with its subfolders).
 * `readEntries` answers in batches and must be called until a batch is empty.
 * @param {any} entry
 * @returns {Promise<{ path: string, file: File }[]>}
 */
export async function walkEntry(entry) {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ path: normalizePath(entry.fullPath || file.name), file }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    children.push(...batch);
  }
  const out = [];
  for (const c of children) out.push(...await walkEntry(c));
  return out;
}

/**
 * Entries of a drop: folders walked with their subfolders, files as they come.
 * The entries must be taken while the drop event is being handled, so this
 * reads them first and walks them afterwards.
 * @param {DataTransfer} dt
 */
export async function entriesFromDrop(dt) {
  const items = [...(dt?.items || [])].filter(i => i.kind === 'file');
  const entries = items.map(i => (typeof i.webkitGetAsEntry === 'function' ? i.webkitGetAsEntry() : null));
  if (!entries.length || entries.some(e => !e)) return entriesFromFiles(dt?.files || []);
  const out = [];
  for (const e of entries) out.push(...await walkEntry(e));
  return out;
}

/**
 * Walk a directory handle of showDirectoryPicker, its name as the first segment.
 * @param {any} dir FileSystemDirectoryHandle
 * @param {string} [prefix]
 */
export async function walkDirectoryHandle(dir, prefix = dir.name) {
  const out = [];
  const names = [];
  for await (const [name, handle] of dir.entries()) names.push([name, handle]);
  for (const [name, handle] of names) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') out.push(...await walkDirectoryHandle(handle, path));
    else out.push({ path: normalizePath(path), file: await handle.getFile() });
  }
  return out;
}

/**
 * What a file is, from its first bytes.
 * @param {Blob} file
 * @returns {Promise<{ kind: 'image'|'tiff'|'heic'|'pdf'|null, type: string|null }>}
 */
export async function sniffFile(file) {
  if (!file.size) return { kind: null, type: null };
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  let type = sniffImageType(head);
  // PDF files may have a few bytes before the header (the format allows up to 1024).
  if (!type && file.size > 5) {
    const start = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    if (new TextDecoder('latin1').decode(start).includes('%PDF-')) type = 'application/pdf';
  }
  if (!type) return { kind: null, type: null };
  if (type === 'application/pdf') return { kind: 'pdf', type };
  if (type === 'image/tiff') return { kind: 'tiff', type };
  if (type === 'image/heic') return { kind: 'heic', type };
  return { kind: 'image', type };
}

/**
 * Items of the list, in natural order: `pending` to read, or `skipped`
 * (hidden, unsupported-format) or `error` (an empty image file) already.
 * @param {{ path: string, file: Blob }[]} entries
 * @param {{ concurrency?: number }} [opts]
 */
export async function classify(entries, { concurrency = 8 } = {}) {
  const items = entries.map(e => ({ path: e.path, file: e.file, size: e.file.size, type: null, kind: null, status: 'pending' }));
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const it = items[next++];
      if (isHidden(it.path)) { it.status = 'skipped'; it.reason = 'hidden'; continue; }
      if (!it.size) {
        if (READABLE_NAME.test(it.path)) { it.status = 'error'; it.error = 'decode-failed'; }
        else { it.status = 'skipped'; it.reason = 'unsupported-format'; }
        continue;
      }
      try {
        const s = await sniffFile(it.file);
        it.kind = s.kind; it.type = s.type;
        if (!s.kind) { it.status = 'skipped'; it.reason = 'unsupported-format'; }
      } catch {
        it.status = 'error'; it.error = 'decode-failed';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, work));
  return items.sort((a, b) => comparePaths(a.path, b.path));
}

/** Give repeated paths " (2)", " (3)"… before the extension. */
export function uniqueAgainst(path, taken) {
  if (!taken.has(path)) return path;
  const slash = path.lastIndexOf('/'), dot = path.lastIndexOf('.');
  const stem = dot > slash + 1 ? path.slice(0, dot) : path, ext = dot > slash + 1 ? path.slice(dot) : '';
  for (let i = 2; ; i++) { const c = `${stem} (${i})${ext}`; if (!taken.has(c)) return c; }
}

/**
 * Counts for the summary line.
 * @param {{ status: string, kind: string|null, reason?: string, size: number }[]} items
 */
export function summarize(items) {
  const s = { files: items.length, images: 0, pdfs: 0, skipped: 0, hidden: 0, bytes: 0 };
  for (const it of items) {
    s.bytes += it.size || 0;
    if (it.status === 'skipped' || it.status === 'error') { s.skipped++; if (it.reason === 'hidden') s.hidden++; continue; }
    if (it.kind === 'pdf') s.pdfs++; else s.images++;
  }
  return s;
}
