// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The task base class without a Worker (the Worker path runs in the browser
// tests): one load for concurrent calls, runs in order, failures, cancel,
// dispose, the one-call form, and the Worker-side message loop with a fake port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Task, oneShot } from '../../sdk/core/task.js';
import { serveTask, runResult } from '../../sdk/core/worker-rpc.js';
import { pinnedUrl } from '../../sdk/core/hub-url.js';

const reg = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const runtime = { ortBundle: '/vendor/x.mjs', ortMjs: '/vendor/y.mjs', ortWasm: '/vendor/z.wasm', transformers: '/vendor/t.js' };

function makeStore({ cached = false } = {}) {
  const calls = { has: 0, get: 0 };
  return { calls, has: async () => { calls.has++; return cached; }, get: async (u, { bytes }) => { calls.get++; return new Blob([new Uint8Array(bytes)]); } };
}
function makeImpl() {
  const log = { load: 0, run: 0, dispose: 0 };
  return {
    log,
    task: 'depth',
    async load(ctx) { log.load++; await new Promise(r => setTimeout(r, 10)); return { device: ctx.device, dtype: ctx.dtype, n: 0 }; },
    async run(state, input, opts) {
      log.run++;
      if (input === 'boom') throw new Error('runtime exploded');
      if (input === 'slow') await new Promise(r => setTimeout(r, 30));
      state.n++;
      return { value: { echo: input, n: state.n, threshold: opts.threshold ?? null } };
    },
    async dispose() { log.dispose++; },
  };
}
const spec = impl => ({ task: 'depth', workerUrl: null, impl: async () => impl, prepare: async x => ({ value: x, transfer: [] }) });
const opts = (store, extra = {}) => ({ worker: false, store, registry: reg, runtime, ...extra });

test('concurrent loads share one; info says model, backend and variant', async () => {
  const impl = makeImpl();
  const store = makeStore();
  const t = new Task(spec(impl), opts(store));
  const [a, b] = await Promise.all([t.load(), t.load()]);
  assert.equal(impl.log.load, 1);
  assert.equal(a, b);
  assert.equal(a.model, 'depth/depth-anything-v2-small');
  assert.equal(a.device, 'wasm');
  assert.equal(a.dtype, 'q8');
  assert.equal(a.fromStore, false);
  assert.equal(t.device, 'wasm');
  assert.equal(store.calls.has, 3, 'asked the store about each file of the variant');
  assert.equal(await t.load(), a);
});

test('fromStore when the store has every file', async () => {
  const t = new Task(spec(makeImpl()), opts(makeStore({ cached: true })));
  assert.equal((await t.load()).fromStore, true);
});

test('runs load first, go in order, and receive their options', async () => {
  const impl = makeImpl();
  const t = new Task(spec(impl), opts(makeStore()));
  const [r1, r2] = await Promise.all([t.run('slow'), t.run('fast', { threshold: 0.7 })]);
  assert.deepEqual([r1.echo, r1.n, r2.echo, r2.n, r2.threshold], ['slow', 1, 'fast', 2, 0.7]);
  assert.equal(impl.log.load, 1);
});

test('without a Worker, a failed run leaves the instance unusable', async () => {
  const t = new Task(spec(makeImpl()), opts(makeStore()));
  await assert.rejects(t.run('boom'), { code: 'run-failed' });
  await assert.rejects(t.run('ok'), { code: 'run-failed', message: /create a new one/ });
});

test('a load that cannot reach the store fails with store-unavailable and can be retried', async () => {
  let up = false;
  const store = { has: async () => { if (!up) throw new Error('no answer'); return true; }, get: async (u, { bytes }) => new Blob([new Uint8Array(bytes)]) };
  const t = new Task(spec(makeImpl()), opts(store));
  await assert.rejects(t.load(), { code: 'store-unavailable' });
  up = true;
  assert.equal((await t.load()).fromStore, true);
});

test('cancel before and during a run', async () => {
  const ac = new AbortController(); ac.abort();
  const t = new Task(spec(makeImpl()), opts(makeStore()));
  await assert.rejects(t.run('x', { signal: ac.signal }), { code: 'aborted' });
  const ac2 = new AbortController();
  const p = t.run('slow', { signal: ac2.signal });
  setTimeout(() => ac2.abort(), 15);
  await assert.rejects(p, { code: 'aborted' });
  const ac3 = new AbortController();
  const t3 = new Task(spec(makeImpl()), opts(makeStore(), { signal: ac3.signal }));
  ac3.abort();
  await assert.rejects(t3.load(), { code: 'aborted' }, 'the constructor signal applies to every call');
});

test('dispose waits, releases once, and refuses later calls', async () => {
  const impl = makeImpl();
  const t = new Task(spec(impl), opts(makeStore()));
  const run = t.run('slow');
  await new Promise(r => setTimeout(r, 1));
  await Promise.all([t.dispose(), t.dispose()]);
  assert.equal((await run).echo, 'slow');
  assert.equal(impl.log.dispose, 1);
  await assert.rejects(t.run('x'), { code: 'disposed' });
  await assert.rejects(t.load(), { code: 'disposed' });
});

test('the one-call form splits instance options from run options', async () => {
  const impl = makeImpl();
  class T extends Task { constructor(o) { super(spec(impl), o); } }
  const r = await oneShot(T)('img', { ...opts(makeStore()), threshold: 0.3 });
  assert.equal(r.threshold, 0.3);
  assert.equal(impl.log.dispose, 1);
});

test('the context reads a file of the variant through the store and checks it', async () => {
  const model = structuredClone(reg.models['depth/depth-anything-v2-small']);
  const cfg = Buffer.from('{"model_type":"depth_anything"}');
  model.parts.main.files['config.json'] = { size: cfg.length, gitOid: createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${cfg.length}\0`), cfg])).digest('hex') };
  for (const v of model.devices.wasm) v.bytes = 0;
  const registry = { ...reg, models: { ...reg.models, 'depth/depth-anything-v2-small': model } };
  const url = pinnedUrl(model.parts.main.repo, model.parts.main.revision, 'config.json');
  const store = { has: async () => false, get: async (u, { bytes }) => { assert.equal(u, url); assert.equal(bytes, cfg.length); return new Blob([cfg]); } };
  let text = null;
  const impl = { ...makeImpl(), async load(ctx) { text = await ctx.text('main:config.json'); await assert.rejects(ctx.bytes('main:README.md'), { code: 'not-in-registry' }); return {}; } };
  await new Task(spec(impl), { worker: false, store, registry, runtime }).load();
  assert.equal(text, cfg.toString());
});

test('the Worker loop answers load, run and dispose, and reports errors as AiErrors', async () => {
  const port = new EventTarget();
  const out = [];
  port.postMessage = m => out.push(m);
  const send = data => port.dispatchEvent(Object.assign(new Event('message'), { data }));
  const impl = makeImpl();
  serveTask(impl, { port });
  assert.equal(out[0].type, 'ready');
  // Store requests from the Worker go out on the same port: answer them like the page would.
  const answerStore = () => { for (const m of out.splice(0)) if (m.type === 'store-has') send({ type: 'store-reply', id: m.id, ok: true, value: true }); else if (m.type) out.push(m); };
  send({ type: 'load', id: 1, opts: { registry: reg, runtime, model: 'depth/depth-anything-v2-small', device: 'wasm' } });
  for (let i = 0; i < 20 && !out.some(m => m.type === 'result' && m.id === 1); i++) { await new Promise(r => setTimeout(r, 5)); answerStore(); }
  const loaded = out.find(m => m.type === 'result' && m.id === 1);
  assert.equal(loaded.value.device, 'wasm');
  assert.equal(loaded.value.fromStore, true);
  send({ type: 'run', id: 2, input: 'boom', opts: {} });
  await new Promise(r => setTimeout(r, 5));
  const err = out.find(m => m.id === 2);
  assert.equal(err.type, 'error');
  assert.equal(err.error.code, 'run-failed');
  send({ type: 'dispose', id: 3 });
  await new Promise(r => setTimeout(r, 5));
  assert.ok(out.some(m => m.id === 3 && m.type === 'result'));
  assert.equal(impl.log.dispose, 1);
  assert.throws(() => runResult({ echo: 1 }), { code: 'run-failed' });
});
