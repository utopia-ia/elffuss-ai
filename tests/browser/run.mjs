#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Browser tests of every site, in both configurations:
//   A  Chrome as a user has it (WebGPU with a real adapter, checked first)
//   B  Chrome with --disable-gpu (no WebGPU, checked first)
//
//   ELFFUSS_AI_CACHE=<dir> ELFFUSS_PLAYWRIGHT_DIR=<node_modules> node tests/browser/run.mjs
//     [--configs A,B] [--sites depth,ocr] [--only <text>] [--browser chrome|chromium|both] [--headed] [--keep-going]
//
// Before anything: the cache has room (5 GB), the weights are cached, the model
// store page is the pinned one, and the sites are built for the test channel
// into $ELFFUSS_AI_CACHE/dist-test. Configuration A takes the machine's
// coordination lock and always gives it back. A spec file under specs/ exports a
// list of { name, sites, configs?, run(t, site) }; see harness.mjs for `t`.
// Nothing the harness writes (logs, profiles) goes to the repo.
import { readFileSync, readdirSync, statfsSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sites as readSites } from '../../deploy/sites.mjs';
import { registryUrls } from '../../sdk/core/registry.js';
import { startSiteServer, startStoreServer, stopAll } from './server.mjs';
import { startHub, cacheHas } from './hf-route.mjs';
import { TestRun, CONFIGS, loadPlaywright, adapterOf, STORE_PORT, HUB_PORT, STORE_ORIGIN } from './harness.mjs';
import { acquire } from './gpu-lock.mjs';
import { brokerPath, checkBroker } from '../../scripts/make-broker-fixture.mjs';
import { mergeStrings } from '../../scripts/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIN_FREE = 5 * 1024 ** 3;

function parse(argv) {
  const o = { configs: ['A', 'B'], sites: null, only: null, browser: 'chrome', headed: false, keepGoing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--configs') o.configs = argv[++i].split(',');
    else if (a === '--sites') o.sites = argv[++i].split(',');
    else if (a === '--only') o.only = argv[++i];
    else if (a === '--browser') o.browser = argv[++i];
    else if (a === '--headed') o.headed = true;
    else if (a === '--keep-going') o.keepGoing = true;
    else throw new Error('unknown option ' + a);
  }
  return o;
}

async function loadSpecs() {
  const dir = join(ROOT, 'tests', 'browser', 'specs');
  const out = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.spec.mjs')).sort()) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    for (const t of mod.default) out.push({ ...t, file: f });
  }
  return out;
}

const pickSites = (spec, all) => {
  if (spec.sites === 'all') return all;
  if (spec.sites === 'apps') return all.filter(s => !s.catalog);
  if (spec.sites === 'catalog') return all.filter(s => s.catalog);
  return all.filter(s => spec.sites.includes(s.site));
};

async function premise(playwright, browser, config, cache, hub, sites, registry, strings) {
  const t = new TestRun({ playwright, browser, config, cache, headless: true, sites, registry, hub, strings });
  try {
    const ctx = await t.newContext();
    const page = await t.page(ctx);
    await page.goto(t.url(sites[0], '/licencias/'));
    const a = await adapterOf(page);
    if (config === 'A') {
      if (!a.adapter || a.adapter.fallback) return { ok: false, skip: browser === 'chromium', reason: `no real WebGPU adapter (${JSON.stringify(a)})` };
      return { ok: true, probe: { available: true, shaderF16: a.adapter.f16, fallbackAdapter: false } };
    }
    if (a.adapter) return { ok: false, skip: false, reason: 'WebGPU could not be removed: --disable-gpu still gives an adapter' };
    return { ok: true, probe: { available: false, shaderF16: false, fallbackAdapter: false } };
  } finally {
    await t.close();
  }
}

async function main(argv) {
  const opts = parse(argv);
  const cache = process.env.ELFFUSS_AI_CACHE;
  if (!cache) throw new Error('set ELFFUSS_AI_CACHE (a directory outside the repo)');
  for (const d of ['hf', 'tmp', 'logs', 'dist-test']) mkdirSync(join(cache, d), { recursive: true });
  const fs = statfsSync(cache);
  if (fs.bavail * fs.bsize < MIN_FREE) throw new Error('less than 5 GB free where ELFFUSS_AI_CACHE lives: free some space first');
  const registry = JSON.parse(readFileSync(join(ROOT, 'registry', 'tasks.json'), 'utf8'));
  if (!cacheHas(cache, registryUrls(registry))) throw new Error('the weight cache is incomplete: run scripts/fetch-weights.mjs');
  const broker = brokerPath(cache);
  if (!existsSync(broker)) throw new Error('no model store page in the cache: run scripts/make-broker-fixture.mjs');
  const bp = checkBroker(readFileSync(broker));
  if (bp.length) throw new Error(bp.join('; '));
  const playwright = loadPlaywright();
  const all = readSites(ROOT);
  const sites = opts.sites ? all.filter(s => opts.sites.includes(s.site) || s.catalog) : all;
  const strings = Object.fromEntries(all.map(s => [s.site, mergeStrings(ROOT, s.dir)]));
  const dist = join(cache, 'dist-test');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), 'all', '--channel', 'test', '--dev', '--out', dist], { stdio: 'inherit' });

  const servers = [];
  const hub = await startHub({ cache, registry, port: HUB_PORT });
  servers.push(hub.server);
  servers.push(await startStoreServer({ file: broker, port: STORE_PORT }));
  for (const s of all) servers.push(await startSiteServer({ site: s, root: join(dist, s.site), port: s.testPort, storeOrigin: STORE_ORIGIN }));

  const specs = (await loadSpecs()).filter(s => !opts.only || s.name.includes(opts.only) || s.file.includes(opts.only));
  const browsers = opts.browser === 'both' ? ['chrome', 'chromium'] : [opts.browser];
  const results = [];
  let failed = 0;
  try {
    for (const browser of browsers) {
      for (const config of opts.configs) {
        const lock = config === 'A' ? await acquire({ job: 'elffuss-ai: browser tests with WebGPU' }) : null;
        try {
          const pre = await premise(playwright, browser, config, cache, hub, sites, registry, strings);
          if (!pre.ok) {
            const line = `${pre.skip ? '–' : '✗'} [${browser} ${config}] premise: ${pre.reason}${pre.skip ? ' (not executed)' : ''}`;
            console.log(line);
            results.push({ browser, config, premise: pre.reason, skipped: pre.skip });
            if (!pre.skip) failed++;
            continue;
          }
          for (const spec of specs) {
            if (spec.configs && !spec.configs.includes(config)) continue;
            for (const site of pickSites(spec, sites)) {
              if (lock?.shouldYield?.()) { lock.release(); throw new Error('another project asked for the machine: stopped between tests'); }
              hub.reset();
              hub.corrupt(null);
              const t = new TestRun({ playwright, browser, config, cache, headless: !opts.headed, sites: all, registry, hub, strings, probe: pre.probe });
              let error = null;
              try { await spec.run(t, site); } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 3).join(' | '); }
              await t.close();
              const ok = !error && t.failures.length === 0;
              if (!ok) failed++;
              const tag = `[${browser} ${config}] ${site.site} · ${spec.name}`;
              console.log(`${ok ? '✓' : '✗'} ${tag}${t.notes.length ? '  (' + t.notes.join('; ') + ')' : ''}`);
              for (const f of t.failures) console.log(`    · ${f}`);
              if (error) console.log(`    · threw: ${error}`);
              results.push({ browser, config, site: site.site, test: spec.name, ok, failures: t.failures, error, notes: t.notes });
              if (!ok && !opts.keepGoing && process.env.ELFFUSS_AI_STOP_ON_FAIL === '1') throw new Error('stopped at the first failure');
            }
          }
        } finally {
          lock?.release();
        }
      }
    }
  } finally {
    await stopAll(servers);
    const log = join(cache, 'logs', `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(log, JSON.stringify(results, null, 2));
    const passed = results.filter(r => r.ok).length;
    console.log(`\nbrowser tests: ${passed} passed, ${failed} failed, ${results.filter(r => r.skipped).length} configurations not executed (log in $ELFFUSS_AI_CACHE/logs/)`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('✗ ' + (e.message || e)); process.exitCode = 1; });
}
