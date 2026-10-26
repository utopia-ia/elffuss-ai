// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// ocr.elffuss.com: read the text of images, photos, scans and PDF files, also
// whole folders with their subfolders. The list is made first (nothing is
// decoded), then it is read file by file and page by page in this browser: at
// once when the model is already here (or its download was agreed on this
// page), else after the primary button, which says what it downloads; each card fills in when its file is done, with its text, its
// lines and their boxes. The results are kept per file and page and leave as
// one .txt per file, a Markdown and a JSON document, or all of them in a ZIP
// made here. Nothing is sent anywhere: what is downloaded is the model (through
// the Elffuss model store) and the software that runs it, from this site.

import { createShell } from './shared/shell.js';
import { Ocr } from './sdk/ocr/index.js';
import { entriesFromFiles, entriesFromDrop, walkDirectoryHandle, classify, summarize, commonRoot, uniqueAgainst, MAX_FILES, CONFIRM_FILES, CONFIRM_BYTES } from './folder.js';
import { readQueue } from './queue.js';
import { openDocument } from './documents.js';
import { fileText, markdown, jsonDocument, modelInfo, zipEntries, zipBytes, zipName, finalStatus } from './export.js';
import { drawPage, clearPage } from './overlay.js';

/** The tool's name in the documents it writes. */
const TOOL = 'ocr.elffuss.com';

/**
 * Longest side a page is read at. The detector's working memory grows with the
 * pixels of its input, and a WebAssembly heap never shrinks: browsers that
 * report a large device memory read up to the detector's own limit; the rest,
 * and those that do not say, up to 2560 pixels. A page that fails is read once
 * more, smaller still.
 */
const READ_SIDE = (globalThis.navigator?.deviceMemory ?? 0) >= 8 ? 4000 : 2560;
const RETRY_SIDE = READ_SIDE > 2560 ? 2560 : 1600;

const shell = await createShell();
const { t, lang, els, config, model, modelId } = shell;
const $ = (sel, root = document) => root.querySelector(sel);
const plural = new Intl.PluralRules(lang);
const count = (key, n) => t(`count.${key}.${plural.select(n) === 'one' ? 'one' : 'other'}`, { n: n.toLocaleString(lang) });

/** Make an element: properties, data-* values, children (text or nodes). */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'data') Object.assign(n.dataset, v);
    else if (k === 'class') n.className = v;
    else n[k] = v;
  }
  n.append(...children.filter(c => c != null && c !== false));
  return n;
}
const ghost = (text, action, onClick) => {
  const b = el('button', { className: 'ghost', type: 'button', textContent: text, data: { action } });
  b.addEventListener('click', onClick);
  return b;
};

const state = { items: [], root: null, reading: false, pause: null, device: null, fallback: null, shown: null, done: false };
const cards = new Map(); // item → li
const ui = {
  files: $('input[data-input="files"]'),
  folder: $('input[data-input="folder"]'),
  camera: $('input[data-input="camera"]'),
  queue: $('[data-role="queue"]'),
  summary: $('[data-role="queue-summary"]'),
  list: $('[data-role="files"]'),
  exports: $('[data-role="exports"]'),
  resultSummary: $('[data-role="result-summary"]'),
  note: $('[data-role="model-note"]'),
  pause: $('[data-action="pause"]'),
  resume: $('[data-action="resume"]'),
  cancel: $('[data-action="cancel"]'),
  clear: $('[data-action="clear"]'),
};

// The model's own notes (for this one: the «¡» it does not have).
if (ui.note && model?.notes?.[lang]) { ui.note.textContent = model.notes[lang]; ui.note.hidden = false; }

// ── the task ───────────────────────────────────────────────────────────────

function onTaskProgress(p) {
  // The queue says what is being read; the shell says how the download goes.
  if (p.status === 'running' || p.status === 'done') return;
  if (p.status === 'ready') { if (state.last) progress(state.last); return; }
  shell.onProgress(p);
}
// In test builds a failure asked for in the query (?test-fail=…) fires once per
// page: the task made for the one retry on WASM after a failure on WebGPU is a
// new task, and it must run clean, as it would after a real WebGPU failure.
let made = 0;
const runner = shell.taskRunner(o => new Ocr({ ...o, test: o.test && made++ ? { ...o.test, failRun: false, failLoad: false } : o.test, onProgress: onTaskProgress }));

async function read(input, { signal, maxSide }) {
  const { result, device, fallback } = await runner.run(input, { signal, maxSide });
  state.device = device;
  if (fallback) state.fallback = fallback;
  return result;
}

// ── the list ───────────────────────────────────────────────────────────────

const typeName = it => (it.type ? it.type.split('/')[1].replace(/^x-/, '').toUpperCase() : t('type.unknown'));

/** What a card says about its file: the list's status while reading, the documents' after. */
const cardStatus = it => (it.status === 'running' && !state.reading ? 'pending' : it.status);

function reasonText(it) {
  const status = it.status === 'pending' || it.status === 'running' ? it.status : finalStatus(it);
  if (status === 'skipped' && it.reason === 'unsupported-format' && it.kind === 'heic') return t('reason.heic');
  if (status === 'skipped') return t('reason.' + it.reason);
  if (status === 'error') return t('reason.' + (it.error || 'run-failed'));
  return '';
}

function summaryText() {
  const s = summarize(state.items);
  const what = [s.images && count('images', s.images), s.pdfs && count('pdfs', s.pdfs)].filter(Boolean).join(t('list.and')) || t('list.nothing');
  return t(s.skipped ? 'list.summaryOut' : 'list.summary', { files: count('files', s.files), what, skipped: count('skipped', s.skipped) });
}

async function add(entries, how) {
  shell.retryStorage(); // a store that was down when the page loaded may be back
  if (!entries.length) { shell.setStatus(t('list.empty')); return; }
  const root = commonRoot(entries.map(e => e.path));
  if (root && how !== 'files') {
    entries = entries.map(e => ({ ...e, path: e.path.slice(root.length + 1) }));
    state.root ??= root;
  }
  if (state.items.length + entries.length > MAX_FILES) { shell.setStatus(t('list.tooMany', { max: MAX_FILES.toLocaleString(lang) })); return; }
  const bytes = entries.reduce((s, e) => s + (e.file.size || 0), 0);
  if (entries.length > CONFIRM_FILES || bytes > CONFIRM_BYTES) {
    const size = bytes >= 1e9 ? `${(bytes / 1e9).toLocaleString(lang, { maximumFractionDigits: 1 })} GB` : `${Math.round(bytes / 1e6).toLocaleString(lang)} MB`;
    if (!globalThis.confirm(t('list.confirm', { files: count('files', entries.length), size }))) return;
  }
  shell.setStatus(t('list.checking'));
  const items = await classify(entries);
  const taken = new Set(state.items.map(i => i.path));
  for (const it of items) { it.path = uniqueAgainst(it.path, taken); taken.add(it.path); }
  state.items.push(...items);
  state.done = false;
  for (const it of items) if (it.reason !== 'hidden') ui.list.append(card(it));
  ui.queue.hidden = false;
  ui.summary.textContent = summaryText();
  shell.showResult();
  refreshExports();
  setControls();
  if (!state.reading) shell.setStatus(summaryText());
  if (items.some(i => i.status === 'pending')) await shell.inputReady();
}

function clearList() {
  if (state.reading) return;
  if (state.shown) { clearPage(state.shown); state.shown = null; }
  state.items = [];
  state.root = null;
  state.fallback = null;
  state.done = false;
  cards.clear();
  ui.list.replaceChildren();
  ui.queue.hidden = true;
  els.result.hidden = true;
  ui.resultSummary.textContent = '';
  shell.setStatus('');
  setControls();
}

// ── cards ──────────────────────────────────────────────────────────────────

function card(it) {
  const li = el('li', {}, el('article', { className: 'card', data: { path: it.path, status: cardStatus(it) } }));
  cards.set(it, li);
  fillCard(it);
  return li;
}

function metaLine(it) {
  const status = cardStatus(it);
  const parts = [typeName(it)];
  if (it.pages?.length) parts.push(count('pages', it.pages.length));
  parts.push(t('item.' + status));
  const why = reasonText(it);
  if (why) parts.push(why);
  if (status === 'ok' && it.device) parts.push(shell.deviceLabel(it.device));
  return parts.join(' · ');
}

function fillCard(it) {
  const li = cards.get(it);
  if (!li) return;
  const article = li.firstElementChild;
  const status = cardStatus(it);
  article.dataset.status = status;
  const children = [el('h3', { textContent: it.path }), el('p', { className: 'muted', textContent: metaLine(it), data: { role: 'meta' } })];
  if (status === 'ok') {
    const multi = it.pages.length > 1;
    for (const p of it.pages) {
      const section = el('section', { data: { page: String(p.page) } });
      if (multi) section.append(el('h4', { textContent: t('page.title', { n: p.page }) }));
      if (p.error) { section.append(el('p', { className: 'muted', textContent: t('reason.' + p.error) })); children.push(section); continue; }
      if (p.orientation) section.append(el('p', { className: 'muted', textContent: t('page.turned', { deg: p.orientation }), data: { role: 'turned' } }));
      if (p.lowConfidence) section.append(el('p', { textContent: t('page.lowConfidence'), data: { role: 'low-confidence' } }));
      const details = el('details', { open: state.items.filter(x => x.reason !== 'hidden').length === 1 },
        el('summary', { textContent: p.text ? t('text.title') : t('reason.no-text') }),
        el('pre', { textContent: p.text, data: { role: 'text' } }));
      const lines = el('details', {},
        el('summary', { textContent: t('lines.title', { n: p.lines.length }) }),
        el('ol', { data: { role: 'lines' } }, ...p.lines.map(l => el('li', {}, el('span', { textContent: l.text }), ' ', el('span', { className: 'muted', textContent: `(${l.score.toLocaleString(lang, { maximumFractionDigits: 2 })})` })))));
      const figure = el('figure', { className: 'stage', hidden: true }, el('canvas', {}), el('canvas', { className: 'overlay' }));
      const toggle = ghost(t('action.showBoxes'), 'show-boxes', () => toggleBoxes(it, p, figure, toggle));
      section.append(details, lines, el('p', { className: 'actions' }, toggle), figure);
      children.push(section);
    }
    children.push(el('p', { className: 'actions' },
      ghost(t('action.copy'), 'copy', () => copy(fileText(it).replace(/\f/g, '\n'))),
      ghost(t('action.downloadTxt'), 'download-txt', () => shell.download(new Blob([fileText(it)], { type: 'text/plain;charset=utf-8' }), `${it.path.split('/').pop()}.txt`))));
  }
  article.replaceChildren(...children);
}

async function toggleBoxes(it, page, figure, button) {
  if (!figure.hidden) { clearPage(figure); state.shown = null; button.textContent = t('action.showBoxes'); return; }
  if (state.shown) {
    clearPage(state.shown);
    for (const b of document.querySelectorAll('button[data-action="show-boxes"]')) b.textContent = t('action.showBoxes');
  }
  try {
    const doc = await openDocument(it, config.runtime);
    try {
      const { input } = await doc.page(page.page - 1);
      const bmp = await createImageBitmap(input, input instanceof Blob ? { imageOrientation: 'from-image' } : undefined);
      try { drawPage(figure, bmp, page.lines, page); } finally { bmp.close(); }
    } finally { await doc.close?.(); }
    state.shown = figure;
    button.textContent = t('action.hideBoxes');
  } catch (err) {
    shell.showError(err);
  }
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); shell.setStatus(t('action.copied')); }
  catch { shell.setStatus(t('action.copyFailed')); }
}

// ── reading ────────────────────────────────────────────────────────────────

function setControls() {
  const pending = state.items.some(i => i.status === 'pending');
  if (!shell.busy) shell.setReady(pending);
  ui.pause.hidden = !state.reading || Boolean(state.pause);
  ui.resume.hidden = !state.reading || !state.pause;
  ui.cancel.hidden = !state.reading;
  ui.clear.hidden = state.reading || !state.items.length;
}

function progress(p) {
  state.last = p;
  const text = p.pages > 1
    ? t('read.progressPages', { file: p.file, files: p.files, page: p.page, pages: p.pages, path: p.item.path })
    : t('read.progress', { file: p.file, files: p.files, path: p.item.path });
  shell.setStatus(state.pause ? t('read.paused') : text);
  if (els.progress) { els.progress.hidden = false; els.progress.max = p.files; els.progress.value = p.file - 1 + (p.page - 1) / p.pages; }
  const li = cards.get(p.item);
  if (li) li.firstElementChild.dataset.status = 'running';
}

async function readAll({ signal }) {
  if (!state.items.some(i => i.status === 'pending')) return; // all read already (added while reading)
  state.reading = true;
  state.done = false;
  setControls();
  shell.showResult();
  const onAbort = () => resume();
  signal.addEventListener('abort', onAbort, { once: true });
  let stopped = null;
  try {
    ({ stopped } = await readQueue(state.items, {
      open: item => openDocument(item, config.runtime),
      read,
      onProgress: progress,
      onItem: item => { fillCard(item); refreshExports(); },
    }, { signal, paused: () => (state.pause ? waitWhilePaused() : undefined), maxSide: READ_SIDE, retrySide: RETRY_SIDE }));
  } finally {
    signal.removeEventListener('abort', onAbort);
    state.reading = false;
    state.pause = null;
    // Finished files were drawn as they finished; only the ones left to read change back.
    for (const it of state.items) if (it.status === 'pending') fillCard(it);
    if (els.progress) els.progress.hidden = true;
    refreshExports();
  }
  if (stopped) throw stopped;
  const n = s => state.items.filter(i => finalStatus(i) === s && i.reason !== 'hidden').length;
  shell.setStatus(t('read.done', { ok: n('ok'), skipped: n('skipped'), errors: n('error') }) + (state.fallback ? ' ' + t('fallback.wasm') : ''));
  // One image or one page read: show its boxes at once.
  const visible = state.items.filter(i => i.reason !== 'hidden');
  if (visible.length === 1 && finalStatus(visible[0]) === 'ok' && visible[0].pages.length === 1 && !visible[0].pages[0].error) {
    const li = cards.get(visible[0]);
    const button = li?.querySelector('button[data-action="show-boxes"]');
    const figure = li?.querySelector('figure.stage');
    if (button && figure) await toggleBoxes(visible[0], visible[0].pages[0], figure, button);
  }
  // The downloads of what was read, on screen as the reading ends.
  if (!ui.exports.hidden) ui.exports.scrollIntoView?.({ block: 'center' });
  state.done = true;
}

/** The queue waits here between pages while paused; the page says so. */
async function waitWhilePaused() {
  state.waiting = true;
  shell.setStatus(t('read.paused'));
  try { await state.pause?.promise; } finally { state.waiting = false; }
}

function pause() { if (!state.reading || state.pause) return; let r; state.pause = { promise: new Promise(res => { r = res; }), resolve: () => r() }; setControls(); shell.setStatus(t('read.paused')); }
function resume() { const p = state.pause; state.pause = null; p?.resolve(); setControls(); }

// ── exports ────────────────────────────────────────────────────────────────

const exportTexts = () => ({
  title: t('export.title'),
  header: t('export.header', { tool: TOOL, model: model.name[lang], author: model.base.author, license: model.license }),
  page: t('page.title', { n: '{n}' }),
  noText: t('export.noText'),
  reasons: Object.fromEntries(['hidden', 'unsupported-format', 'pdf-password', 'decode-failed', 'too-large', 'out-of-memory', 'run-failed', 'no-text', 'not-processed'].map(k => [k, t('reason.' + k)])),
});

function documents() {
  const md = markdown(state.items, exportTexts());
  const json = jsonDocument(state.items, { tool: TOOL, build: config.build, model: modelInfo(modelId, model), device: state.device, fallback: state.fallback });
  return { markdown: md, json };
}

function refreshExports() {
  const any = state.items.some(i => finalStatus(i) === 'ok');
  ui.exports.hidden = !any;
  const s = summarize(state.items);
  const n = st => state.items.filter(i => finalStatus(i) === st && i.reason !== 'hidden').length;
  ui.resultSummary.textContent = state.items.length ? t('result.summary', { ok: n('ok'), files: s.files - s.hidden }) : '';
}

function exportName(ext) { return `${t('export.base')}.${ext}`; }

$('[data-action="download-zip"]').addEventListener('click', () => {
  const docs = documents();
  const entries = zipEntries(state.items, { dir: t('export.base'), md: exportName('md'), json: exportName('json') }, docs);
  shell.download(new Blob([zipBytes(entries)], { type: 'application/zip' }), zipName(state.root || t('export.files')));
});
$('[data-action="download-md"]').addEventListener('click', () => shell.download(new Blob([documents().markdown], { type: 'text/markdown;charset=utf-8' }), exportName('md')));
$('[data-action="download-json"]').addEventListener('click', () => shell.download(new Blob([documents().json], { type: 'application/json' }), exportName('json')));
$('[data-action="copy-all"]').addEventListener('click', () => copy(documents().markdown));

// ── inputs ─────────────────────────────────────────────────────────────────

const failed = err => shell.showError(err);
ui.files.addEventListener('change', () => { const list = [...ui.files.files]; ui.files.value = ''; add(entriesFromFiles(list), 'files').catch(failed); });
ui.folder.addEventListener('change', () => { const list = [...ui.folder.files]; ui.folder.value = ''; add(entriesFromFiles(list), 'folder').catch(failed); });
ui.camera.addEventListener('change', () => { const list = [...ui.camera.files]; ui.camera.value = ''; add(entriesFromFiles(list), 'files').catch(failed); });
$('[data-action="pick-folder"]').addEventListener('click', async () => {
  if (typeof globalThis.showDirectoryPicker !== 'function') { ui.folder.click(); return; }
  let dir;
  try { dir = await globalThis.showDirectoryPicker({ mode: 'read' }); }
  catch (err) { if (err?.name !== 'AbortError') ui.folder.click(); return; }
  add(await walkDirectoryHandle(dir), 'folder').catch(failed);
});
$('[data-action="take-photo"]').addEventListener('click', () => ui.camera.click());
els.drop.addEventListener('dragover', e => e.preventDefault());
els.drop.addEventListener('drop', e => {
  e.preventDefault();
  entriesFromDrop(e.dataTransfer).then(entries => add(entries, 'drop')).catch(failed);
});
// A file dropped outside the zone must not replace the page.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());
let pasted = 0;
document.addEventListener('paste', e => {
  const imgs = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
  if (!imgs.length) return;
  e.preventDefault();
  const files = imgs.map(f => new File([f], `${t('paste.name')}-${++pasted}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }));
  add(entriesFromFiles(files), 'paste').catch(failed);
});

ui.pause.addEventListener('click', pause);
ui.resume.addEventListener('click', resume);
ui.cancel.addEventListener('click', () => { resume(); shell.cancel(); });
ui.clear.addEventListener('click', clearList);
shell.onPrimary(readAll, { after: setControls });

if (config.testHooks) {
  shell.diagnostics.ocr = {
    get reading() { return state.reading; },
    get waiting() { return Boolean(state.waiting); },
    get done() { return state.done; },
    items: () => state.items.map(i => ({ path: i.path, status: finalStatus(i), reason: i.reason ?? null, error: i.error ?? null, kind: i.kind, type: i.type, pages: (i.pages || []).map(p => ({ page: p.page, text: p.text ?? null, error: p.error ?? null, lines: p.lines?.length ?? 0, orientation: p.orientation ?? 0, lowConfidence: Boolean(p.lowConfidence) })) })),
    documents,
    pause, resume,
    readSide: READ_SIDE,
  };
}
setControls();
