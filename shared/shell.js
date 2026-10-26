// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The page side shared by every tool site: texts in es/en, the model store, the
// storage panel, the primary button's label, progress, errors by code, the
// one-time WebGPU→WASM retry, downloads of results, and the inputs (drop zone,
// file picker, paste). A site's app.js builds on it:
//
//   import { createShell } from './shared/shell.js';
//   import { Depth } from './sdk/depth/index.js';
//   const shell = await createShell();
//   const runner = shell.taskRunner(opts => new Depth(opts));
//   shell.bindInput({ onFiles: files => …, paste: true });
//   shell.onPrimary(async ({ signal }) => { const { result, device } = await runner.run(file, { signal }); … });
//
// It never writes inline styles (states use the `hidden` attribute), never sets
// colours, and never asks the store for anything but `has` and `get`.

import config from '../config.js';
import { createStoreClient } from '../sdk/core/store-client.js';
import { loadRegistry, getModel, variantFiles, resolveRef } from '../sdk/core/registry.js';
import { probeWebGPU, chooseVariant } from '../sdk/core/device.js';
import { AiError, isAiError, toAiError } from '../sdk/core/errors.js';
import { createTaskRunner } from './runner.js';
import { onInput, runQueued } from './autorun.js';

const $ = (sel, root = document) => root.querySelector(sel);
const mb = bytes => (bytes / 1e6 < 10 ? (Math.round(bytes / 1e5) / 10) : Math.round(bytes / 1e6));

/**
 * Fill {name} placeholders.
 * @param {string} s
 * @param {Record<string, string|number>} [vars]
 */
export function fill(s, vars = {}) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Format a byte count as the pages do ("31 MB", "4.2 MB" / "4,2 MB"). */
export function formatMB(bytes, lang = 'es') {
  const n = mb(bytes);
  return lang === 'es' ? String(n).replace('.', ',') : String(n);
}

/** Test flags read from the query string, in test builds only. */
export function testFlags(params, enabled) {
  if (!enabled) return null;
  const t = {};
  if (params.get('test-pin')) t.pins = { transformers: params.get('test-pin'), onnxruntimeWeb: params.get('test-pin') };
  if (params.get('test-fail') === 'load') t.failLoad = true;
  if (params.get('test-fail') === 'run') t.failRun = true;
  return Object.keys(t).length ? t : {};
}

/**
 * Set up the page.
 * @param {{ config?: typeof config, document?: Document }} [opts]
 */
export async function createShell({ config: cfg = config } = {}) {
  const lang = document.documentElement.lang === 'en' ? 'en' : 'es';
  const strings = await (await fetch(new URL(`../strings.${lang}.json`, import.meta.url), { credentials: 'same-origin' })).json();
  const t = (key, vars) => fill(strings[key] ?? key, vars);
  const params = new URLSearchParams(location.search);
  const requested = ['webgpu', 'wasm'].includes(params.get('device')) ? params.get('device') : 'auto';
  const diagnostics = { csp: [], errors: [], device: null, fallback: null };
  document.addEventListener('securitypolicyviolation', e => diagnostics.csp.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI || ''), where: 'page' }));
  if (cfg.testHooks) globalThis.__elffuss = diagnostics;

  const els = {
    main: $('main'),
    primary: $('main button.primary'),
    progress: $('main progress'),
    status: $('main p.status'),
    result: $('main section.result'),
    drop: $('main label.drop'),
    storage: $('[data-role="storage"]'),
    modelSize: $('[data-role="model-size"]'),
  };

  const registry = await loadRegistry();
  const modelId = cfg.model;
  const model = modelId ? getModel(registry, modelId) : null;
  const store = createStoreClient({ url: cfg.storeUrl });
  const probe = await probeWebGPU();
  let choice = null;
  let choiceError = null;
  if (model) {
    try { choice = chooseVariant(model, requested, probe); } catch (err) { choiceError = toAiError(err); }
  }
  const files = choice ? variantFiles(model, choice.variant) : [];
  let primaryLabels = null; // { run, download }
  let busy = null;
  let storageKnown = false; // the store answered the last time it was asked
  let stored = false; // ...and it had every file of the variant
  let consented = false; // the primary button was pressed on this page (the download is agreed)
  let primaryAction = null; // what the primary button does (onPrimary)
  let afterAction = null; // called when it has ended
  let queued = false; // an input arrived while an action was running: run it after
  let lastCheck = null; // the latest question to the store

  const setStatus = text => { if (els.status) els.status.textContent = text || ''; };
  const showProgress = (loaded, total) => {
    if (!els.progress) return;
    if (total > 0) { els.progress.hidden = false; els.progress.max = total; els.progress.value = loaded; }
    else els.progress.hidden = true;
  };

  const shell = {
    t, lang, config: cfg, registry, model, modelId, store, probe, requested, diagnostics, els,
    /** The variant this browser will use, or null when none fits. */
    get choice() { return choice; },
    /** Files of that variant, resolved. */
    get files() { return files; },

    /** Message of an error, by its code. */
    errorText(err) {
      const e = toAiError(err);
      const missing = files.reduce((s, f) => s + f.size, 0);
      return t('error.' + e.code, { size: `${formatMB(missing, lang)} MB` });
    },
    showError(err) {
      const e = toAiError(err);
      diagnostics.errors.push(e.code);
      setStatus(shell.errorText(e));
      showProgress(0, 0);
      return e;
    },
    setStatus,
    /** Progress events of a task (see sdk/core/progress.js). */
    onProgress(p) {
      if (p.status === 'downloading' && p.total) {
        showProgress(p.loaded, p.total);
        setStatus(t('status.downloading', { loaded: formatMB(p.loaded, lang), total: formatMB(p.total, lang) }));
      } else if (p.status) {
        if (p.status !== 'downloading') showProgress(0, 0);
        setStatus(t('status.' + p.status));
      }
    },
    /** Options for `new <Task>(…)` on this page. */
    taskOptions(extra = {}) {
      return {
        device: requested,
        model: modelId,
        registry,
        store,
        runtime: cfg.runtime,
        onProgress: p => shell.onProgress(p),
        onCspViolation: v => diagnostics.csp.push(v),
        test: testFlags(params, cfg.testHooks),
        ...extra,
      };
    },
    /**
     * A task with the site's options and the one-time retry on WASM: with device
     * 'auto', a run that fails on WebGPU is repeated once on WASM and the result
     * says so (`fallback`). With an explicit device there is no second attempt.
     * @param {(opts: object) => { run: Function, dispose: Function, device: string|null }} factory
     */
    taskRunner(factory) {
      return createTaskRunner({
        requested,
        factory,
        options: device => shell.taskOptions({ device }),
        attempted: () => choice?.device ?? null,
        onDevice: (device, fallback) => { diagnostics.device = device; diagnostics.fallback = fallback; },
      });
    },

    /** Label the primary button from what the store has. */
    labels(run, download) { primaryLabels = { run, download }; return shell.refreshStorage(); },
    /** Ask the store again (see check); the answer also says whether the model is all here. */
    refreshStorage() { lastCheck = shell.check(); return lastCheck; },
    /**
     * Ask the store which files of the model this browser has; update the storage
     * panel, the model size and the primary button.
     * @returns {Promise<{ have: number, missing: number } | null>}
     */
    async check() {
      const items = els.storage ? [...els.storage.querySelectorAll('li[data-url]')] : [];
      const urls = new Map(items.map(li => [li.dataset.url, Number(li.dataset.size)]));
      for (const f of files) urls.set(f.url, f.size);
      let has;
      try {
        has = new Map(await Promise.all([...urls].map(async ([u, size]) => [u, await store.has(u, size)])));
      } catch (err) {
        storageKnown = false;
        stored = false;
        document.documentElement.dataset.storage = 'unknown';
        const s = $('[data-role="storage-summary"]', els.storage || document);
        if (s) s.textContent = t('storage.unknown');
        if (!busy) shell.showError(err);
        if (primaryLabels && els.primary) els.primary.textContent = fill(primaryLabels.download, { size: `${formatMB(files.reduce((x, f) => x + f.size, 0), lang)} MB` });
        return null;
      }
      storageKnown = true;
      document.documentElement.dataset.storage = 'known';
      for (const li of items) {
        const st = $('[data-role="storage-state"]', li);
        if (st) st.textContent = t(has.get(li.dataset.url) ? 'storage.stored' : 'storage.missing');
        li.dataset.needed = String(files.some(f => f.url === li.dataset.url));
      }
      const missing = files.filter(f => !has.get(f.url)).reduce((s, f) => s + f.size, 0);
      const have = files.filter(f => has.get(f.url)).length;
      stored = files.length > 0 && missing === 0;
      const summary = $('[data-role="storage-summary"]', els.storage || document);
      if (summary) summary.textContent = missing ? t('storage.summary', { have, count: files.length, size: `${formatMB(missing, lang)} MB` }) : t('storage.complete');
      if (els.modelSize && files.length) els.modelSize.textContent = t('size.mb', { n: formatMB(files.reduce((s, f) => s + f.size, 0), lang) });
      if (primaryLabels && els.primary) els.primary.textContent = missing ? fill(primaryLabels.download, { size: `${formatMB(missing, lang)} MB` }) : primaryLabels.run;
      return { have, missing };
    },

    /**
     * Run an action from the primary button: one at a time, with a cancel signal,
     * errors shown by code, and the storage panel refreshed afterwards. Pressing
     * the button agrees to the download it names; from then on (and whenever the
     * model is already in this browser) a new input runs the action by itself
     * (inputReady).
     * @param {(ctx: { signal: AbortSignal }) => Promise<void>} fn
     * @param {{ after?: () => void }} [o] `after`: called when each run of it has ended (the button is back)
     */
    onPrimary(fn, { after } = {}) {
      primaryAction = fn;
      afterAction = after || null;
      els.primary?.addEventListener('click', () => { consented = true; shell.act(fn); });
    },
    async act(fn) {
      if (busy) return;
      const ac = new AbortController();
      busy = ac;
      queued = false;
      if (els.primary) els.primary.disabled = true;
      try { await fn({ signal: ac.signal }); }
      catch (err) { shell.showError(err); }
      finally {
        busy = null;
        if (els.primary) els.primary.disabled = false;
        shell.refreshStorage().catch(() => {});
        if (fn === primaryAction) try { afterAction?.(); } catch { /* the page's own */ }
        const again = runQueued({ queued, aborted: ac.signal.aborted });
        queued = false;
        if (again && primaryAction) setTimeout(() => shell.act(primaryAction), 0);
      }
    },
    /**
     * A new input is ready (an image chosen, a folder listed, the camera on): run
     * the primary action now when the model is in this browser or the person has
     * already agreed to its download on this page; after the action in progress
     * if there is one; otherwise leave it to the primary button, which says what
     * it downloads, and bring that button into view.
     * @param {{ blocked?: boolean }} [o] `blocked`: this browser cannot run it
     * @returns {Promise<'run'|'queue'|'wait'>}
     */
    async inputReady({ blocked = false } = {}) {
      if (!busy) await lastCheck?.catch(() => null);
      const what = onInput({ busy: Boolean(busy), consented, stored: stored && storageKnown, blocked: blocked || !primaryAction });
      if (what === 'queue') queued = true;
      else if (what === 'run') shell.act(primaryAction);
      else if (!blocked && els.primary && !els.primary.disabled) els.primary.scrollIntoView?.({ block: 'nearest' });
      return what;
    },
    /** The model is all in this browser (the store's last answer). */
    get stored() { return stored && storageKnown; },
    /** Cancel the action in progress, if any. */
    cancel() { busy?.abort(); },
    get busy() { return Boolean(busy); },

    /** Enable or disable the primary button. */
    setReady(ready) { if (els.primary) els.primary.disabled = !ready; },
    /** Show the result section. */
    showResult() { if (els.result) els.result.hidden = false; return els.result; },
    clearResult() {
      if (!els.result) return;
      for (const n of [...els.result.children]) if (!/^H[1-6]$/.test(n.tagName)) n.remove();
      els.result.hidden = true;
    },
    /** Label of a backend ("With WebGPU" / "With WASM"). */
    deviceLabel(device) { return t('device.' + device); },

    /** Offer a Blob as a file to save, through a temporary blob: URL. */
    download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    /**
     * Files from the drop zone: its file input, drag and drop on it, and paste
     * anywhere on the page (pasted images arrive as pegado-1.png / pasted-1.png).
     * @param {{ onFiles: (files: File[], how: 'pick'|'drop'|'paste') => void, paste?: boolean, input?: HTMLInputElement }} opts
     */
    bindInput({ onFiles: given, paste = false, input = $('input[type="file"]', els.drop || document) }) {
      const onFiles = (list, how) => { shell.retryStorage(); given(list, how); };
      input?.addEventListener('change', () => { if (input.files?.length) onFiles([...input.files], 'pick'); input.value = ''; });
      els.drop?.addEventListener('dragover', e => { e.preventDefault(); });
      els.drop?.addEventListener('drop', e => {
        e.preventDefault();
        const list = [...(e.dataTransfer?.files || [])];
        if (list.length) onFiles(list, 'drop');
      });
      if (paste) {
        let n = 0;
        document.addEventListener('paste', e => {
          const imgs = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
          if (!imgs.length) return;
          e.preventDefault();
          onFiles(imgs.map(f => new File([f], `${lang === 'es' ? 'pegado' : 'pasted'}-${++n}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })), 'paste');
        });
      }
    },
    /** Ask the store again when the last question went unanswered (it may be back). */
    retryStorage() {
      if (!storageKnown && document.documentElement.dataset.storage === 'unknown' && !busy) shell.refreshStorage().catch(() => {});
    },
  };

  if (choiceError) shell.showError(choiceError);
  // The page is usable at once; the store is asked in the background. Until it
  // answers, the primary button says it will download the whole model, which is
  // the most it can do; the answer may shorten that.
  if (els.primary && els.primary.dataset.labelRun) {
    primaryLabels = { run: els.primary.dataset.labelRun, download: els.primary.dataset.labelDownload || els.primary.dataset.labelRun };
    if (files.length) els.primary.textContent = fill(primaryLabels.download, { size: `${formatMB(files.reduce((x, f) => x + f.size, 0), lang)} MB` });
  }
  shell.storageChecked = shell.refreshStorage().catch(() => null);
  lastCheck = shell.storageChecked;
  document.documentElement.dataset.shell = 'ready';
  return shell;
}

export { AiError, isAiError, toAiError, resolveRef };
