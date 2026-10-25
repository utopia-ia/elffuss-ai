// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The SDK core in a real browser, on each app's origin with its CSP, through
// the real model store, on both configurations: the model's variant comes from
// the store at the pinned commit, is checked, loads on the expected backend with
// the pinned runtimes, and runs once. Then: a reload downloads nothing; an
// explicit backend is honoured or refused, never swapped; a failure inside the
// runtime is followed by a working run (a new Worker); a fake pin is refused; a
// corrupted file is refused; a cancelled download stops and resumes.
import { chooseVariant } from '../../../sdk/core/device.js';
import { variantFiles } from '../../../sdk/core/registry.js';
import { expectedDevice } from '../harness.mjs';

const variantUrls = (t, site, device) => {
  const m = t.registry.models[site.models[0]];
  const choice = chooseVariant(m, device, t.probe);
  return variantFiles(m, choice.variant).map(f => f.url).sort();
};

export default [
  {
    name: 'loads the model through the store, on the expected backend, and runs it',
    sites: 'apps',
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/__test__/core.html', { wait: 'smoke' });
      const s = await t.smoke(page);
      if (!t.ok(!s.error, `load failed: ${JSON.stringify(s.error)}`)) return;
      const want = expectedDevice(site, t.registry, t.config);
      t.equal(s.info.device, want, 'backend');
      t.equal(s.info.fromStore, false, 'a fresh profile had nothing stored');
      t.ok(s.runs.length === 1 && s.runs[0].ok, `run: ${JSON.stringify(s.runs[0])}`);
      t.equal(t.hubFull(), variantUrls(t, site, 'auto'), 'downloaded exactly the files of the variant, once each');
      t.equal(t.hub.counts.full.length, t.hubFull().length, 'no file downloaded twice');
      await t.noCsp(page);
      t.noPageErrors();
      t.networkClean(site);
      // Reload: everything from the store, nothing from the Hub.
      t.hub.reset();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__smoke?.done === true, null, { timeout: 600000 });
      const s2 = await t.smoke(page);
      t.ok(!s2.error && s2.info.fromStore === true, `reload from the store: ${JSON.stringify(s2.error || s2.info)}`);
      t.equal(t.hubTotal(), 0, 'reload: zero Hub requests, whole or probes');
      t.note(`device ${s.info.device} ${s.info.dtype}; ${s.runs[0].value?.kind}`);
    },
  },
  {
    name: 'an explicit backend is honoured or refused, never swapped',
    sites: 'apps',
    async run(t, site) {
      const ctx = await t.newContext();
      const m = t.registry.models[site.models[0]];
      const page = await t.open(ctx, site, '/__test__/core.html?device=webgpu', { wait: 'smoke' });
      const s = await t.smoke(page);
      if (!m.devices.webgpu) t.equal(s.error?.code, 'device-unsupported', 'WebGPU on a WebAssembly-only model');
      else if (t.config === 'B') t.equal(s.error?.code, 'webgpu-unavailable', 'WebGPU without an adapter');
      else t.equal(s.info?.device, 'webgpu', 'WebGPU when asked and available');
      const page2 = await t.open(ctx, site, '/__test__/core.html?device=wasm', { wait: 'smoke' });
      const s2 = await t.smoke(page2);
      t.equal(s2.info?.device, 'wasm', 'WebAssembly when asked');
      t.equal(t.hub.counts.refused.length, 0, 'nothing refused by the Hub mock');
      t.noPageErrors();
    },
  },
  {
    name: 'after a failure inside the runtime, the next run works in a new Worker',
    sites: 'apps',
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/__test__/core.html?test-fail=run&runs=2', { wait: 'smoke' });
      const s = await t.smoke(page);
      if (!t.ok(!s.error, `load: ${JSON.stringify(s.error)}`)) return;
      t.equal(s.runs.map(r => r.ok), [false, true], 'first run fails on purpose, second works');
      t.ok(['run-failed'].includes(s.runs[0].code), `first run code ${s.runs[0].code}`);
      t.equal(t.hub.counts.full.length, t.hubFull().length, 'the new Worker read the files from the store, not the Hub');
      t.noPageErrors();
    },
  },
  {
    name: 'a runtime that is not the pinned version is refused',
    sites: 'apps',
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/__test__/core.html?test-pin=0.0.0', { wait: 'smoke' });
      const s = await t.smoke(page);
      t.equal(s.error?.code, 'runtime-mismatch', 'a fake pin fails the version check');
    },
  },
  {
    name: 'a file with one byte changed is refused; after emptying the store it loads',
    sites: 'apps',
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const urls = variantUrls(t, site, 'auto');
      const m = t.registry.models[site.models[0]];
      const weights = urls.filter(u => /\.onnx$/.test(u));
      t.hub.corrupt(weights[0]);
      const page = await t.open(ctx, site, '/__test__/core.html', { wait: 'smoke' });
      const s = await t.smoke(page);
      t.equal(s.error?.code, 'integrity', 'corrupted file');
      t.hub.corrupt(null);
      await t.clearStore(ctx);
      t.hub.reset();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__smoke?.done === true, null, { timeout: 600000 });
      const s2 = await t.smoke(page);
      t.ok(!s2.error && s2.runs[0]?.ok, `the good file loads: ${JSON.stringify(s2.error)}`);
      t.ok(m, 'model');
    },
  },
  {
    name: 'cancelling a download stops it, and the next load resumes and works',
    sites: ['cutout'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const weight = variantUrls(t, site, 'auto').find(u => /\.onnx$/.test(u));
      const size = t.registry.models[site.models[0]].parts.main.files['onnx/model_fp16.onnx'].size;
      const page = await t.open(ctx, site, '/__test__/core.html?cancel-at=0.3', { wait: 'smoke' });
      const s = await t.smoke(page);
      t.equal(s.error?.code, 'aborted', 'the load says cancelled');
      await page.waitForTimeout(1500);
      const sent = t.hub.served.get(weight) || 0;
      t.ok(sent < size, `the download stopped before the end (${Math.round(100 * sent / size)}% sent)`);
      t.hub.reset();
      await page.goto(t.url(site, '/__test__/core.html'), { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => globalThis.__smoke?.done === true, null, { timeout: 600000 });
      const s2 = await t.smoke(page);
      t.ok(!s2.error && s2.runs[0]?.ok, `the next load works: ${JSON.stringify(s2.error)}`);
      t.ok(t.hub.counts.ranged.length > 0 || (t.hub.served.get(weight) || 0) < size, 'it resumed from what was stored');
    },
  },
  {
    name: 'a full store says store-quota and keeps what another site stored',
    sites: ['depth'],
    configs: ['B'],
    async run(t, site) {
      const ctx = await t.newContext();
      const page = await t.open(ctx, site, '/__test__/core.html', { wait: 'smoke' });
      t.ok(!(await t.smoke(page)).error, 'depth stores its model');
      const cutout = t.sites.find(s => s.site === 'cutout');
      await t.storeQuota(ctx, 60 * 1e6);
      const p2 = await t.open(ctx, cutout, '/__test__/core.html', { wait: 'smoke' });
      t.equal((await t.smoke(p2)).error?.code, 'store-quota', 'the big model does not fit');
      await t.storeQuota(ctx, null);
      t.hub.reset();
      const p3 = await t.open(ctx, site, '/__test__/core.html', { wait: 'smoke' });
      const s3 = await t.smoke(p3);
      t.ok(!s3.error && s3.info.fromStore, 'depth is still in the store');
      t.equal(t.hubTotal(), 0, 'and is not downloaded again');
    },
  },
];
