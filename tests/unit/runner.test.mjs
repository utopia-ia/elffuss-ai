// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The site's one retry: with 'auto', a WebGPU failure is repeated once on WASM in
// a new task and reported; never with an explicit device, never after a cancel or
// a store or file failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRunner } from '../../shared/runner.js';
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

test('a failure on WASM is not retried', async () => {
  const { made, factory } = fakeTasks({ autoDevice: 'wasm', wasm: new AiError('run-failed', 'x') });
  const r = createTaskRunner({ requested: 'auto', factory, options: device => ({ device }) });
  await assert.rejects(r.run('img'), { code: 'run-failed' });
  assert.equal(made.length, 1);
});
