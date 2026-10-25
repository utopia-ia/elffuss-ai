// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Test builds only. Loads the site's model through the SDK core exactly as a site
// would (model store, pinned files, integrity, pinned runtimes, the site's CSP, a
// Worker made through Trusted Types) and runs it once on a synthetic input, so
// the harness can check the core on both backends before any task module exists.
// Query: ?device=auto|webgpu|wasm  ?test-fail=run|load  ?test-pin=0.0.0  ?runs=2
//        ?cancel-at=0.3 (cancel the load once that fraction of the download arrived)
import config from '../config.js';
import { Task } from '../sdk/core/task.js';
import { createStoreClient } from '../sdk/core/store-client.js';
import { testFlags } from '../shared/shell.js';

const params = new URLSearchParams(location.search);
const device = ['webgpu', 'wasm', 'auto'].includes(params.get('device')) ? params.get('device') : 'auto';
const state = { csp: [], progress: [], info: null, runs: [], error: null, done: false, generations: [] };
globalThis.__smoke = state;
document.addEventListener('securitypolicyviolation', e => state.csp.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI || ''), where: 'page' }));
const status = document.querySelector('p.status');

/** A 96×96 gradient made from pixel arithmetic (no colours written anywhere). */
async function syntheticImage() {
  const w = 96, h = 96;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    data[i] = (x * 255 / w) | 0; data[i + 1] = (y * 255 / h) | 0; data[i + 2] = ((x + y) * 127 / w) | 0; data[i + 3] = 255;
  }
  return createImageBitmap(new ImageData(data, w, h));
}

const store = createStoreClient({ url: config.storeUrl });
const cancelAt = Number(params.get('cancel-at')) || 0;
const ac = new AbortController();
const spec = { task: null, workerUrl: new URL('./smoke-worker.js', import.meta.url), impl: () => import('./smoke-impl.js') };
const task = new Task(spec, {
  device, model: config.model, store, runtime: config.runtime,
  onProgress: p => {
    state.progress.push(p.status);
    if (cancelAt && p.status === 'downloading' && p.total && p.loaded / p.total >= cancelAt && !ac.signal.aborted) { state.cancelledAt = p.loaded; ac.abort(); }
  },
  onCspViolation: v => state.csp.push(v),
  test: testFlags(params, config.testHooks),
});

try {
  state.info = await task.load({ signal: ac.signal });
  const runs = Math.max(1, Math.min(4, Number(params.get('runs')) || 1));
  for (let i = 0; i < runs; i++) {
    try {
      state.runs.push({ ok: true, value: await task.run(await syntheticImage()) });
    } catch (err) {
      state.runs.push({ ok: false, code: err.code, message: String(err.message).slice(0, 200) });
    }
  }
} catch (err) {
  state.error = { code: err.code || 'run-failed', message: String(err.message || err).slice(0, 300) };
}
state.done = true;
status.textContent = state.error ? `error: ${state.error.code}` : 'done';
