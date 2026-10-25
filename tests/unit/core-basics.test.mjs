// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Errors with codes, the turn queue, byte progress, Trusted Types URLs and the
// runtime version checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiError, ERROR_CODES, isAiError, fromStoreError, toAiError, serializeError, deserializeError, throwIfAborted } from '../../sdk/core/errors.js';
import { createQueue } from '../../sdk/core/queue.js';
import { createProgress, missingBytes } from '../../sdk/core/progress.js';
import { isAllowedScriptUrl } from '../../sdk/core/tt.js';
import { assertTransformersRuntime, assertOrtRuntime, assertPdfjsRuntime } from '../../sdk/core/runtimes.js';
import { PINS } from '../../sdk/core/runtime-pins.js';

test('AiError carries a known code, a cause and details', () => {
  const cause = new Error('inner');
  const e = new AiError('integrity', 'bad file', { cause, details: { url: 'u' } });
  assert.equal(e.name, 'AiError');
  assert.equal(e.code, 'integrity');
  assert.equal(e.cause, cause);
  assert.deepEqual(e.details, { url: 'u' });
  assert.ok(isAiError(e) && isAiError(e, 'integrity') && !isAiError(e, 'aborted'));
  assert.throws(() => new AiError('nope', 'x'), TypeError);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
});

test('model-store answers map to codes', () => {
  const cases = { permiso: 'store-permission', cuota: 'store-quota', red: 'store-network', http: 'store-network', integridad: 'integrity', cancelado: 'aborted', otro: 'store-network' };
  for (const [tipo, code] of Object.entries(cases)) assert.equal(fromStoreError({ tipo, message: 'm' }).code, code, tipo);
  assert.equal(fromStoreError({ tipo: 'cuota' }, { url: 'u' }).details.url, 'u');
});

test('errors survive postMessage as plain objects', () => {
  const e = new AiError('runtime-mismatch', 'v', { cause: new TypeError('t'), details: { a: 1 } });
  const back = deserializeError(structuredClone(serializeError(e)));
  assert.equal(back.code, 'runtime-mismatch');
  assert.equal(back.message, 'v');
  assert.equal(back.cause.message, 't');
  assert.deepEqual(back.details, { a: 1 });
  assert.equal(toAiError(new Error('x')).code, 'run-failed');
  assert.equal(toAiError(Object.assign(new Error('a'), { name: 'AbortError' })).code, 'aborted');
  assert.equal(deserializeError({ code: 'weird' }).code, 'run-failed');
  const ac = new AbortController(); ac.abort();
  assert.throws(() => throwIfAborted(ac.signal), { code: 'aborted' });
});

test('the queue runs in order and keeps going after a rejection', async () => {
  const q = createQueue();
  const order = [];
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const a = q.run(async () => { await wait(20); order.push('a'); return 1; });
  const b = q.run(async () => { order.push('b'); throw new Error('b fails'); });
  const c = q.run(async () => { order.push('c'); return 3; });
  assert.equal(await a, 1);
  await assert.rejects(b, /b fails/);
  assert.equal(await c, 3);
  assert.deepEqual(order, ['a', 'b', 'c']);
  await q.idle();
  assert.equal(q.pending, 0);
});

test('progress sums bytes from the registry sizes and knows what came from the store', () => {
  const events = [];
  let t = 0;
  const p = createProgress({ files: [{ url: 'a', size: 100 }, { url: 'b', size: 50 }], onProgress: e => events.push(e), throttle: 10, now: () => t });
  assert.equal(p.total, 150);
  p.status('checking');
  p.file('a', 40); // throttled? first emit at t=0 after status at t=0 → dropped
  t = 20; p.file('a', 60);
  p.file('zzz', 5); // not one of ours
  t = 40; p.done('a', { fromStore: false });
  p.done('b', { fromStore: true });
  assert.equal(p.loaded, 150);
  assert.equal(p.fromStore, false);
  assert.equal(events[0].status, 'checking');
  assert.ok(events.some(e => e.status === 'downloading' && e.loaded === 60 && e.total === 150));
  assert.equal(events.at(-1).loaded, 150);
  const q = createProgress({ files: [{ url: 'a', size: 1 }] });
  q.done('a', { fromStore: true });
  assert.equal(q.fromStore, true);
  assert.equal(missingBytes([{ url: 'a', size: 3 }, { url: 'b', size: 4 }], new Map([['a', true]])), 4);
});

test('Trusted Types: only same-origin scripts under /v/ and /vendor/', () => {
  const o = 'https://ocr.elffuss.com';
  globalThis.location = { href: o + '/', origin: o };
  try {
    assert.equal(isAllowedScriptUrl(o + '/v/abc/sdk/ocr/worker.js', o), true);
    assert.equal(isAllowedScriptUrl('/vendor/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs', o), true);
    for (const bad of ['https://evil.example/v/x.js', o + '/v/x.js?y', o + '/v/../x.js', o + '/x.js', o + '/v/x.json', 'blob:' + o + '/1', 'data:text/javascript,1']) {
      assert.equal(isAllowedScriptUrl(bad, o), false, bad);
    }
  } finally { delete globalThis.location; }
});

test('runtime checks: pinned versions pass, anything else is runtime-mismatch', () => {
  const versions = { common: PINS.onnxruntimeWeb, web: PINS.onnxruntimeWeb };
  const ort = { env: { versions } };
  const tf = { env: { version: PINS.transformers, backends: { onnx: { versions } } } };
  assertTransformersRuntime(tf, ort);
  assertOrtRuntime(ort);
  assertPdfjsRuntime({ version: PINS.pdfjs });
  assert.throws(() => assertTransformersRuntime({ env: { ...tf.env, version: '4.3.0' } }, ort), { code: 'runtime-mismatch' });
  assert.throws(() => assertTransformersRuntime(tf, { env: { versions: { ...versions } } }), { code: 'runtime-mismatch' }, 'a second ONNX Runtime instance');
  assert.throws(() => assertOrtRuntime({ env: { versions: { common: '1.30.0', web: '1.29.0' } } }), { code: 'runtime-mismatch' });
  assert.throws(() => assertPdfjsRuntime({ version: '5.0.0' }), { code: 'runtime-mismatch' });
  assert.throws(() => assertTransformersRuntime(tf, ort, { ...PINS, transformers: '0.0.0' }), { code: 'runtime-mismatch' }, 'a fake pin must fail');
});
