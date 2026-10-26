// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What a reading gives back, built only from the results (text, never
// images): one .txt per file (pages separated by a form feed, as pdftotext
// does), one Markdown document with every file, one JSON document
// (`elffuss-ocr/1`) with the paths, pages, text and the lines with their
// boxes, and a ZIP with all of them, folders kept. Nothing here says when or
// on what it ran: no dates inside the documents, no device details.

import { createZip } from './sdk/core/zip.js';

/** Schema of the JSON document. */
export const SCHEMA = 'elffuss-ocr/1';

/** Status of an item in the documents (`pending` became not-processed). */
export function finalStatus(item) {
  return item.status === 'pending' || item.status === 'running' ? 'not-processed' : item.status;
}

/**
 * The .txt of one read file: each page's text and a line break, pages
 * separated by a form feed. UTF-8 without BOM.
 * @param {{ pages?: { text: string }[] }} item
 */
export function fileText(item) {
  return (item.pages || []).map(p => (p.text ? p.text + '\n' : '')).join('\f');
}

/** Escape recognised text for Markdown (it is text, never markup). */
export function escapeMarkdown(text) {
  return String(text).split('\n').map(line => {
    let l = line.replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/`/g, '\\`');
    l = l.replace(/^(\s*)([#>+*|-])/, '$1\\$2').replace(/^(\s*)(\d+)([.)])/, '$1$2\\$3');
    return l;
  }).join('\n');
}

/**
 * Texts of the documents, by language.
 * @typedef {{ title: string, header: string, page: string, noText: string, reasons: Record<string, string> }} ExportTexts
 */

/**
 * The combined Markdown document.
 * @param {object[]} items
 * @param {ExportTexts} t
 */
export function markdown(items, t) {
  const out = [`# ${t.title}`, '', t.header, ''];
  const without = [];
  for (const it of items) {
    const status = finalStatus(it);
    if (status === 'skipped' && it.reason === 'hidden') continue;
    const pages = (it.pages || []).filter(p => p.text);
    if (status !== 'ok' || !pages.length) {
      without.push(`- ${escapeMarkdown(it.path)}: ${t.reasons[status === 'ok' ? 'no-text' : status === 'skipped' ? it.reason : status === 'error' ? it.error : status] || t.reasons['run-failed']}`);
      continue;
    }
    out.push(`## ${escapeMarkdown(it.path)}`, '');
    const multi = (it.pages || []).length > 1;
    for (const p of it.pages) {
      if (multi) out.push(`### ${t.page.replace('{n}', String(p.page))}`, '');
      if (p.error) out.push(`_${t.reasons[p.error] || t.reasons['run-failed']}_`, '');
      else if (p.text) out.push(escapeMarkdown(p.text), '');
      else out.push(`_${t.reasons['no-text']}_`, '');
    }
  }
  if (without.length) out.push(`## ${t.noText}`, '', ...without, '');
  return out.join('\n');
}

/**
 * The JSON document (schema `elffuss-ocr/1`).
 * @param {object[]} items
 * @param {{ tool: string, build: string, model: object, device: string|null, fallback?: object|null }} meta
 */
export function jsonDocument(items, meta) {
  const files = items.map(it => {
    const status = finalStatus(it);
    const f = { path: it.path };
    if (status === 'skipped' && it.reason === 'hidden') return { ...f, status, reason: 'hidden' };
    f.type = it.type || null;
    f.size = it.size;
    f.status = status;
    if (status === 'skipped') f.reason = it.reason;
    if (status === 'error') f.error = it.error;
    if (status === 'ok') {
      f.device = it.device || null;
      f.pages = (it.pages || []).map(p => (p.error
        ? { page: p.page, error: p.error }
        : { page: p.page, width: p.width, height: p.height, ...(p.orientation ? { orientation: p.orientation } : {}), ...(p.lowConfidence ? { lowConfidence: true } : {}),
          text: p.text, lines: p.lines.map(l => ({ text: l.text, score: l.score, box: l.box, polygon: l.polygon })) }));
    }
    return f;
  });
  const count = s => files.filter(f => f.status === s).length;
  const doc = {
    schema: SCHEMA,
    tool: meta.tool,
    build: meta.build,
    model: meta.model,
    device: meta.device,
    ...(meta.fallback ? { fallback: meta.fallback } : {}),
    files,
    summary: {
      files: files.length, ok: count('ok'), skipped: count('skipped'), errors: count('error'), notProcessed: count('not-processed'),
      pages: files.reduce((s, f) => s + (f.pages ? f.pages.filter(p => !p.error).length : 0), 0),
    },
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** The model block of the JSON document, from the registry entry. */
export function modelInfo(modelId, model) {
  const out = { id: modelId };
  for (const [name, p] of Object.entries(model.parts)) out[name] = { repo: p.repo, revision: p.revision };
  out.license = model.license;
  return out;
}

/** `ocr-<name>-<yyyymmdd-hhmm>.zip`, with a name safe for any file system. */
export function zipName(base, date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const safe = String(base || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80);
  return `ocr-${safe ? safe + '-' : ''}${stamp}.zip`;
}

/**
 * Every entry of the ZIP: `<dir>/<path>.txt` per read file, then the Markdown
 * and the JSON document.
 * @param {object[]} items
 * @param {{ dir: string, md: string, json: string }} names `texto`, `texto.md`, `texto.json` (or their English names)
 * @param {{ markdown: string, json: string }} docs
 */
export function zipEntries(items, names, docs) {
  const entries = [];
  for (const it of items) if (finalStatus(it) === 'ok') entries.push({ name: `${names.dir}/${it.path}.txt`, data: fileText(it) });
  entries.push({ name: names.md, data: docs.markdown }, { name: names.json, data: docs.json });
  return entries;
}

/** The ZIP itself. */
export function zipBytes(entries, date) {
  return createZip(entries, { date });
}
