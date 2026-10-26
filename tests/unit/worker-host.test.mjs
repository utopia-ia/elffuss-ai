// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The page side of a task Worker, with a fake Worker that answers like
// sdk/core/worker-rpc.js: a failure of the runtime replaces the Worker (so the
// model loads again, from the store), and a run refused for its input keeps it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerHost } from '../../sdk/core/worker-host.js';
import { serializeError, AiError } from '../../sdk/core/errors.js';

globalThis.location = { origin: 'http://localhost:8792', href: 'http://localhost:8792/' };

/** A Worker that loads at once and answers each run with what `plan(input)` says. */
function installFakeWorker(plan) {
  const made = [];
  globalThis.Worker = class extends EventTarget {
    constructor(url, opts) {
      super();
      this.url = String(url); this.opts = opts; this.terminated = false; this.loads = 0;
      made.push(this);
      setTimeout(() => this.#emit({ type: 'ready' }), 1);
    }
    #emit(data) { if (!this.terminated) this.dispatchEvent(Object.assign(new Event('message'), { data })); }
    postMessage(m) {
      setTimeout(() => {
        if (m.type === 'load') { this.loads++; this.#emit({ type: 'result', id: m.id, value: { device: 'wasm' } }); }
        if (m.type === 'run') {
          const r = plan(m.input);
          if (r instanceof Error) this.#emit({ type: 'error', id: m.id, error: serializeError(r) });
          else this.#emit({ type: 'result', id: m.id, value: r });
        }
        if (m.type === 'dispose') this.#emit({ type: 'result', id: m.id, value: true });
      }, 1);
    }
    terminate() { this.terminated = true; }
  };
  return made;
}

const store = { has: async () => true, get: async () => new Blob([]) };

test('a run refused for its input keeps the Worker and its model', async () => {
  const made = installFakeWorker(x => (x === 'broken.png' ? new AiError('decode-failed', 'not an image') : `ok:${x}`));
  const host = createWorkerHost({ workerUrl: 'http://localhost:8792/v/dev/sdk/ocr/worker.js', store });
  await host.load({});
  for (const bad of ['broken.png', 'broken.png', 'broken.png']) await assert.rejects(host.run(bad, {}), { code: 'decode-failed' });
  assert.equal(host.generation, 1, 'three broken files, one Worker');
  assert.equal(made[0].terminated, false);
  assert.equal(await host.run('good.png', {}), 'ok:good.png', 'the same Worker reads the next file');
  assert.equal(made[0].loads, 1, 'the model was loaded once');
  await host.dispose();
});

test('a failure of the runtime replaces the Worker', async () => {
  const made = installFakeWorker(x => (x === 'crash' ? new AiError('run-failed', 'OrtRun failed') : `ok:${x}`));
  const host = createWorkerHost({ workerUrl: 'http://localhost:8792/v/dev/sdk/ocr/worker.js', store });
  await host.load({});
  await assert.rejects(host.run('crash', {}), { code: 'run-failed' });
  assert.equal(made[0].terminated, true, 'the failed Worker is gone');
  assert.equal(host.alive, false);
  await host.load({});
  assert.equal(host.generation, 2, 'the next call starts a new Worker');
  await host.dispose();
});

test('an input code raised by the runtime itself still replaces the Worker', async () => {
  const made = installFakeWorker(() => new AiError('too-large', 'allocation failed inside the runtime', { details: { runtime: true } }));
  const host = createWorkerHost({ workerUrl: 'http://localhost:8792/v/dev/sdk/ocr/worker.js', store });
  await host.load({});
  await assert.rejects(host.run('big', {}), { code: 'too-large' });
  assert.equal(made[0].terminated, true);
  await host.dispose();
});
