// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The site's one retry: with 'auto', a WebGPU failure is repeated once on WASM in
// a new task and reported; never with an explicit device, never after a cancel or
// a store or file failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRunner, retryOptions } from '../../shared/runner.js';
import { AiError } from '../../sdk/core/errors.js';

function fakeTasks(plan) {
  const made = [];
  const factory = opts => {
    const device = opts.device === 'wasm' ? 'wasm' : plan.autoDevice;
    const t = { opts, device, disposed: false, async run(x) { const r = plan[device]; if (r instanceof Error) throw r; return `${r}:${x}`; }, async dispose() { t.disposed = true; } };
    made.push(t);
    return t;
  };
  return { made, factory };
}

test('auto: a WebGPU failure is repeated once on WASM, in a new task, and reported', async () => {
  const { made, factory } = fakeTasks({ autoDevice: 'webgpu', webgpu: new AiError('run-failed', 'shader'), wasm: 'ok' });
  const seen = [];
  const r = createTaskRunner({ requested: 'auto', factory, options: device => ({ device }), onDevice: (d, f) => seen.push([d, f]) });
  const out = await r.run('img');
  assert.deepEqual(out, { result: 'ok:img', device: 'wasm', fallback: { from: 'webgpu', reason: 'run-failed' } });
  assert.equal(made.length, 2);
  assert.equal(made[0].disposed, true);
  assert.equal(made[1].opts.device, 'wasm');
  assert.deepEqual(seen, [['wasm', { from: 'webgpu', reason: 'run-failed' }]]);
  assert.equal((await r.run('b')).device, 'wasm', 'later runs stay on WASM');
});

test('no retry with an explicit device, after a cancel, or for store and file failures', async () => {
  for (const [requested, err] of [['webgpu', new AiError('run-failed', 'x')], ['auto', new AiError('aborted', 'x')], ['auto', new AiError('store-quota', 'x')], ['auto', new AiError('integrity', 'x')]]) {
    const { made, factory } = fakeTasks({ autoDevice: 'webgpu', webgpu: err, wasm: 'ok' });
    const r = createTaskRunner({ requested, factory, options: device => ({ device }) });
    await assert.rejects(r.run('img'), { code: err.code });
    assert.equal(made.length, 1, `${requested} ${err.code}`);
  }
});

/**
 * Tasks that behave like the SDK's Task with a Worker: `device` is known only
 * after load(), and a failed run forgets it (the Worker and what it loaded are
 * gone). Each records the options it was made with.
 */
function workerLikeTasks(plan) {
  const made = [];
  const factory = opts => {
    const target = opts.device === 'wasm' ? 'wasm' : plan.autoDevice;
    let info = null;
    let failRunUsed = false;
    const t = {
      opts, disposed: false, loads: 0,
      get device() { return info?.device ?? null; },
      async load() { t.loads++; info = { device: target }; return info; },
      async run(x) {
        if (!info) await t.load();
        const fail = (opts.test?.failRun && !failRunUsed) || plan[target] instanceof Error;
        if (opts.test?.failRun) failRunUsed = true;
        if (fail) { info = null; throw plan[target] instanceof Error ? plan[target] : new AiError('run-failed', 'test hook'); }
        return `${plan[target]}:${x}`;
      },
      async dispose() { t.disposed = true; },
    };
    made.push(t);
    return t;
  };
  return { made, factory };
}

test('auto: the retry happens with tasks that forget their device when a run fails', async () => {
  const { made, factory } = workerLikeTasks({ autoDevice: 'webgpu', webgpu: new AiError('run-failed', 'device lost'), wasm: 'ok' });
  const r = createTaskRunner({ requested: 'auto', factory, options: device => ({ device }) });
  const out = await r.run('img');
  assert.deepEqual(out, { result: 'ok:img', device: 'wasm', fallback: { from: 'webgpu', reason: 'run-failed' } });
  assert.equal(made.length, 2);
  assert.equal(made[0].loads, 1, 'loaded once, before the run, to know its backend');
});

test('auto: the retry does not inherit the hooks that break a first run or load', async () => {
  const { made, factory } = workerLikeTasks({ autoDevice: 'webgpu', webgpu: 'gpu', wasm: 'ok' });
  const options = device => ({ device, test: { failRun: true, failLoad: true, pins: { transformers: '0' } } });
  const r = createTaskRunner({ requested: 'auto', factory, options });
  const out = await r.run('img');
  assert.deepEqual(out.fallback, { from: 'webgpu', reason: 'run-failed' }, 'the hook broke the WebGPU run');
  assert.equal(out.result, 'ok:img', 'and the WASM retry worked');
  assert.deepEqual(made[1].opts.test, { failRun: false, failLoad: false, pins: { transformers: '0' } }, 'other test options stay');
  assert.equal(retryOptions({ device: 'wasm' }).test, undefined);
});

test('auto without WebGPU: a run broken by the hook fails, and the next run of the same task works', async () => {
  const { made, factory } = workerLikeTasks({ autoDevice: 'wasm', wasm: 'ok' });
  const r = createTaskRunner({ requested: 'auto', factory, options: device => ({ device, test: { failRun: true } }) });
  await assert.rejects(r.run('img'), { code: 'run-failed' });
  assert.equal((await r.run('img')).result, 'ok:img');
  assert.equal(made.length, 1);
});

/** Tasks whose load fails on one backend, like a WebGPU session that cannot be created. */
function failingLoadTasks(plan) {
  const made = [];
  const factory = opts => {
    const target = opts.device === 'wasm' ? 'wasm' : plan.autoDevice;
    let info = null;
    const t = {
      opts, disposed: false,
      get device() { return info?.device ?? null; },
      async load() { if (plan.loadFails === target) throw new AiError('run-failed', 'session could not be created'); info = { device: target }; return info; },
      async run(x) { if (!info) await t.load(); return `${target}:${x}`; },
      async dispose() { t.disposed = true; },
    };
    made.push(t);
    return t;
  };
  return { made, factory };
}

test('auto: a WebGPU failure while loading is repeated once on WASM too', async () => {
  const { made, factory } = failingLoadTasks({ autoDevice: 'webgpu', loadFails: 'webgpu' });
  const seen = [];
  const r = createTaskRunner({ requested: 'auto', factory, options: device => ({ device }), attempted: () => 'webgpu', onDevice: (d, f) => seen.push([d, f]) });
  const out = await r.run('img');
  assert.deepEqual(out, { result: 'wasm:img', device: 'wasm', fallback: { from: 'webgpu', reason: 'run-failed' } });
  assert.equal(made.length, 2);
  assert.equal(made[0].disposed, true);
  assert.deepEqual(seen, [['wasm', { from: 'webgpu', reason: 'run-failed' }]]);
});

test('a load failure is not retried when the attempt was on WASM, or with an explicit device', async () => {
  for (const [requested, attempted, autoDevice] of [['auto', 'wasm', 'wasm'], ['webgpu', 'webgpu', 'webgpu']]) {
    const { made, factory } = failingLoadTasks({ autoDevice, loadFails: autoDevice });
    const r = createTaskRunner({ requested, factory, options: device => ({ device }), attempted: () => attempted });
    await assert.rejects(r.run('img'), { code: 'run-failed' });
    assert.equal(made.length, 1, `${requested} on ${attempted}`);
  }
});

test('a failure on WASM is not retried', async () => {
  const { made, factory } = fakeTasks({ autoDevice: 'wasm', wasm: new AiError('run-failed', 'x') });
  const r = createTaskRunner({ requested: 'auto', factory, options: device => ({ device }) });
  await assert.rejects(r.run('img'), { code: 'run-failed' });
  assert.equal(made.length, 1);
});
