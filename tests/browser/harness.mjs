// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// What every browser test gets: a fresh browser profile (a persistent context, so
// storage behaves as for a user, with service workers blocked), the Hub mock
// installed, every request and page error recorded, and helpers to open a site,
// wait for it, and check the common rules (no page errors, no CSP violations,
// no request to anything but the site, the store, and pinned Hub files from the
// store's frame).
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { siteUrl } from '../../deploy/sites.mjs';
import { HUB_ORIGIN } from '../../sdk/core/hub-url.js';

/** Load Playwright from ELFFUSS_PLAYWRIGHT_DIR (a node_modules directory that has it). */
export function loadPlaywright() {
  const dir = process.env.ELFFUSS_PLAYWRIGHT_DIR;
  if (!dir) throw new Error('set ELFFUSS_PLAYWRIGHT_DIR to a node_modules directory that contains playwright');
  return createRequire(join(dirname(dir), 'resolve-from-here.cjs'))('playwright');
}

/** The two configurations every site runs in. */
export const CONFIGS = Object.freeze({
  A: { name: 'A', label: 'WebGPU', args: [] },
  B: { name: 'B', label: 'no WebGPU', args: ['--disable-gpu'] },
});

/** The backend a site's model must end up on in a configuration (from the registry). */
export function expectedDevice(site, registry, config) {
  const m = registry.models[site.models?.[0]];
  if (!m) return null;
  return config === 'A' && m.devices.webgpu ? 'webgpu' : 'wasm';
}

export const STORE_PORT = Number(process.env.ELFFUSS_AI_STORE_PORT || 8789);
export const HUB_PORT = Number(process.env.ELFFUSS_AI_HUB_PORT || 8788);
export const STORE_ORIGIN = `http://localhost:${STORE_PORT}`;

/** Ask the browser what WebGPU it offers on a secure page. */
export async function adapterOf(page) {
  return page.evaluate(async () => {
    if (!navigator.gpu) return { gpu: false, adapter: null };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { gpu: true, adapter: null };
    const i = a.info || {};
    const software = /swiftshader|llvmpipe|lavapipe|software|warp/i.test(`${i.vendor} ${i.architecture} ${i.description}`);
    return { gpu: true, adapter: { fallback: Boolean(i.isFallbackAdapter) || software, f16: a.features.has('shader-f16') } };
  });
}

export class TestRun {
  /**
   * @param {{ playwright: any, browser: 'chrome'|'chromium', config: 'A'|'B', cache: string, headless: boolean,
   *   sites: object[], registry: object, hub: any, strings: Record<string, any> }} o
   */
  constructor(o) {
    Object.assign(this, o);
    this.contexts = [];
    this.failures = [];
    this.notes = [];
    this.pageErrors = [];
    this.requests = [];
  }

  /** A fresh browser profile. */
  async newContext({ javaScriptEnabled = true } = {}) {
    const tmp = join(this.cache, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const dir = mkdtempSync(join(tmp, 'profile-'));
    const ctx = await this.playwright.chromium.launchPersistentContext(dir, {
      ...(this.browser === 'chrome' ? { channel: 'chrome' } : {}),
      headless: this.headless,
      args: CONFIGS[this.config].args,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: true,
      javaScriptEnabled,
      env: { ...process.env, TMPDIR: tmp },
      viewport: { width: 1100, height: 900 },
    });
    await ctx.route(this.hub.pattern, this.hub.handler);
    ctx.on('request', r => {
      let frame = null;
      try { frame = r.frame()?.url() ?? null; } catch { frame = null; }
      this.requests.push({ url: r.url(), method: r.method(), frame, type: r.resourceType(), body: Boolean(r.postDataBuffer()) });
    });
    const watch = page => {
      page.on('pageerror', e => this.pageErrors.push({ page: page.url(), message: String(e.message || e).slice(0, 300) }));
    };
    ctx.pages().forEach(watch);
    ctx.on('page', watch);
    const entry = { ctx, dir };
    this.contexts.push(entry);
    return ctx;
  }

  /** The page of a context (a persistent context opens with one). */
  async page(ctx) {
    return ctx.pages()[0] || ctx.newPage();
  }

  url(site, path = '/') {
    return siteUrl(site, 'test').replace(/\/$/, '') + path;
  }

  /**
   * Open a path of a site and wait for its shell (or the smoke page) to be ready.
   * `shell` also waits for the store's first answer on an app page (the page is
   * usable before it: `shell-only` waits for the shell alone).
   */
  async open(ctx, site, path = '/', { wait = 'shell', timeout = 60000 } = {}) {
    const page = await this.page(ctx);
    await page.goto(this.url(site, path), { waitUntil: 'domcontentloaded' });
    if (wait === 'shell') await page.waitForFunction(() => document.documentElement.dataset.shell === 'ready' && (document.documentElement.dataset.storage || !document.querySelector('main button.primary')), null, { timeout });
    if (wait === 'shell-only') await page.waitForFunction(() => document.documentElement.dataset.shell === 'ready', null, { timeout });
    if (wait === 'smoke') await page.waitForFunction(() => globalThis.__smoke?.done === true, null, { timeout: 10 * timeout });
    return page;
  }

  /** The smoke page's result. */
  smoke(page) {
    return page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__smoke)));
  }

  /** CSP violations a page recorded (shell or smoke). */
  csp(page) {
    return page.evaluate(() => (globalThis.__elffuss?.csp || globalThis.__smoke?.csp || []).slice());
  }

  // ── checks ────────────────────────────────────────────────────────────────
  ok(cond, message) { if (!cond) this.failures.push(message); return Boolean(cond); }
  equal(got, want, message) { return this.ok(Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want), `${message}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
  note(text) { this.notes.push(text); }

  noPageErrors() { this.ok(this.pageErrors.length === 0, `page errors: ${JSON.stringify(this.pageErrors.slice(0, 3))}`); }
  async noCsp(page) { const v = await this.csp(page); this.ok(v.length === 0, `CSP violations: ${JSON.stringify(v.slice(0, 3))}`); }

  /**
   * Only the site's own origin, the store, and pinned Hub files asked by the
   * store's frame; no request with a body; nothing the Hub mock refused.
   */
  networkClean(site, { extra = [] } = {}) {
    const own = new URL(this.url(site)).origin;
    const bad = [];
    for (const r of this.requests) {
      if (r.url.startsWith('data:') || r.url.startsWith('blob:') || r.url === 'about:blank') continue;
      const o = new URL(r.url).origin;
      if (r.body) bad.push(`request with a body: ${r.method} ${r.url}`);
      if (o === own || o === STORE_ORIGIN || extra.includes(o)) continue;
      if (o === HUB_ORIGIN) {
        if (!r.frame || new URL(r.frame).origin !== STORE_ORIGIN) bad.push(`Hub request not made by the store: ${r.url} (frame ${r.frame})`);
        continue;
      }
      bad.push(`request to another origin: ${r.url}`);
    }
    if (this.hub.counts.refused.length) bad.push(`the Hub mock refused: ${this.hub.counts.refused.slice(0, 3).join(', ')}`);
    this.ok(bad.length === 0, bad.slice(0, 5).join(' | '));
  }

  /** Requests the Hub mock served, as a set of URLs. */
  hubFull() { return [...new Set(this.hub.counts.full)].sort(); }
  hubTotal() { return this.hub.counts.full.length + this.hub.counts.probes.length + this.hub.counts.ranged.length; }

  /** Make the model store unreachable for a context. */
  async blockStore(ctx) {
    await ctx.route(`${STORE_ORIGIN}/**`, route => route.abort('connectionrefused'));
  }

  /** Make the model store reachable again. */
  async unblockStore(ctx) {
    await ctx.unroute(`${STORE_ORIGIN}/**`);
  }

  /**
   * Every request that reached the Hub mock (whole files, probes and ranges) is
   * one of `urls`: the files of the variants the test expects, and nothing else
   * of the registry.
   */
  hubOnly(urls, what = 'the expected variant') {
    const allowed = new Set(urls);
    const seen = [...this.hub.counts.full, ...this.hub.counts.probes, ...this.hub.counts.ranged];
    const extra = [...new Set(seen.filter(u => !allowed.has(u)))];
    this.ok(extra.length === 0, `Hub files outside ${what}: ${extra.slice(0, 3).join(', ')}`);
  }

  /** Empty the store's storage of a context, as a user would from Claw (the tools cannot). */
  async clearStore(ctx) {
    const page = await this.page(ctx);
    const s = await ctx.newCDPSession(page);
    await s.send('Storage.clearDataForOrigin', { origin: STORE_ORIGIN, storageTypes: 'all' });
    await s.detach();
  }

  /**
   * Give the store's origin a small quota (or reset it with null). The override
   * lives as long as the DevTools session that set it, so the session is kept.
   */
  async storeQuota(ctx, bytes) {
    const page = await this.page(ctx);
    this.quotaSession ||= await ctx.newCDPSession(page);
    await this.quotaSession.send('Storage.overrideQuotaForOrigin', bytes == null ? { origin: STORE_ORIGIN } : { origin: STORE_ORIGIN, quotaSize: bytes });
  }

  async close() {
    for (const { ctx, dir } of this.contexts.splice(0)) {
      try { await ctx.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
