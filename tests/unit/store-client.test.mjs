// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The model-store client against a fake broker that speaks the real protocol:
// ready handshake, has, get with progress, errors by type, cancel, timeouts.
// The client must never send anything but get, has and cancel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStoreClient } from '../../sdk/core/store-client.js';

const ORIGIN = 'https://models.elffuss.com';

function world({ ready = true, answer = true, handler } = {}) {
  const win = new EventTarget();
  globalThis.addEventListener = win.addEventListener.bind(win);
  globalThis.removeEventListener = win.removeEventListener.bind(win);
  const sent = [];
  const contentWindow = {
    postMessage(msg, targetOrigin) {
      sent.push({ msg, targetOrigin });
      if (!answer) return;
      const reply = data => setTimeout(() => win.dispatchEvent(Object.assign(new Event('message'), { data: { id: msg.id, ...data }, origin: ORIGIN, source: contentWindow })), 1);
      handler?.(msg, reply);
    },
  };
  const iframe = {
    hidden: false, attrs: {}, removed: false, contentWindow,
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { this.removed = true; },
    set src(v) {
      this._src = v;
      if (ready) setTimeout(() => win.dispatchEvent(Object.assign(new Event('message'), { data: { kind: 'elffuss-broker-ready', v: 2, puede: ['get', 'has', 'cancel', 'clear', 'put'] }, origin: ORIGIN, source: contentWindow })), 1);
    },
    get src() { return this._src; },
  };
  const document = { createElement: tag => { assert.equal(tag, 'iframe'); return iframe; }, body: { appendChild() {} } };
  // A message from another window or origin must be ignored.
  const intruder = data => win.dispatchEvent(Object.assign(new Event('message'), { data, origin: 'https://evil.example', source: contentWindow }));
  return { document, iframe, sent, intruder };
}

test('opens a hidden iframe without inline styles and waits for ready', async () => {
  const w = world();
  const c = createStoreClient({ document: w.document });
  const r = await c.ready();
  assert.equal(r.version, 2);
  assert.equal(w.iframe.hidden, true);
  assert.equal(w.iframe.src, ORIGIN + '/');
  assert.equal(w.iframe.attrs.style, undefined);
  c.dispose();
  assert.equal(w.iframe.removed, true);
});

test('has and get, with the exact size and progress', async () => {
  const w = world({
    handler(msg, reply) {
      if (msg.type === 'elffuss-model-has') reply({ kind: 'has', cached: true, size: 4 });
      if (msg.type === 'elffuss-model-get') { reply({ kind: 'progress', loaded: 2, total: 4 }); setTimeout(() => reply({ kind: 'file', file: new Blob([new Uint8Array(4)]) }), 5); }
    },
  });
  const c = createStoreClient({ document: w.document });
  assert.equal(await c.has('https://x/y', 4), true);
  assert.equal(await c.has('https://x/y', 5), false, 'a stored copy of another size does not count');
  const seen = [];
  const f = await c.get('https://x/y', { bytes: 4, onProgress: p => seen.push(p.loaded) });
  assert.equal(f.size, 4);
  assert.deepEqual(seen, [2]);
  const types = new Set(w.sent.map(s => s.msg.type));
  for (const t of types) assert.ok(['elffuss-model-has', 'elffuss-model-get', 'elffuss-model-cancel'].includes(t), t);
  for (const s of w.sent) assert.equal(s.targetOrigin, ORIGIN);
  await assert.rejects(c.get('https://x/y', {}), { code: 'not-in-registry' }, 'never without a size');
  c.dispose();
});

test('error answers become codes; a file of the wrong size is an integrity error', async () => {
  let mode = 'permiso';
  const w = world({
    handler(msg, reply) {
      if (mode === 'size') reply({ kind: 'file', file: new Blob([new Uint8Array(3)]) });
      else reply({ kind: 'error', tipo: mode, message: 'no' });
    },
  });
  const c = createStoreClient({ document: w.document });
  for (const [tipo, code] of [['permiso', 'store-permission'], ['cuota', 'store-quota'], ['red', 'store-network'], ['integridad', 'integrity']]) {
    mode = tipo;
    await assert.rejects(c.get('https://x/y', { bytes: 4 }), { code });
  }
  mode = 'size';
  await assert.rejects(c.get('https://x/y', { bytes: 4 }), { code: 'integrity' });
  c.dispose();
});

test('no ready answer or no reply means store-unavailable', async () => {
  const w = world({ ready: false });
  await assert.rejects(createStoreClient({ document: w.document, readyTimeout: 30 }).ready(), { code: 'store-unavailable' });
  const w2 = world({ answer: false });
  const c = createStoreClient({ document: w2.document, answerTimeout: 30 });
  await assert.rejects(c.has('https://x/y', 1), { code: 'store-unavailable' });
  c.dispose();
});

test('a store that did not open is asked again on the next call, in a new frame', async () => {
  // First frame: no ready answer. Second frame: ready, and it answers has.
  const win = new EventTarget();
  globalThis.addEventListener = win.addEventListener.bind(win);
  globalThis.removeEventListener = win.removeEventListener.bind(win);
  const frames = [];
  const document = {
    createElement() {
      const n = frames.length;
      const contentWindow = {
        postMessage(msg) {
          if (msg.type === 'elffuss-model-has') setTimeout(() => win.dispatchEvent(Object.assign(new Event('message'), { data: { id: msg.id, kind: 'has', cached: true, size: 7 }, origin: ORIGIN, source: contentWindow })), 1);
        },
      };
      const f = {
        n, removed: false, contentWindow, setAttribute() {}, remove() { this.removed = true; },
        set src(v) {
          if (n >= 1) setTimeout(() => win.dispatchEvent(Object.assign(new Event('message'), { data: { kind: 'elffuss-broker-ready', v: 2, puede: ['get', 'has', 'cancel'] }, origin: ORIGIN, source: contentWindow })), 1);
        },
      };
      frames.push(f);
      return f;
    },
    body: { appendChild() {} },
  };
  const c = createStoreClient({ document, readyTimeout: 20 });
  await assert.rejects(c.has('https://x/y', 7), { code: 'store-unavailable' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].removed, true, 'the frame that never opened is removed');
  assert.equal(await c.has('https://x/y', 7), true, 'the next question opens a new frame and gets its answer');
  assert.equal(frames.length, 2);
  assert.equal(await c.has('https://x/y', 7), true);
  assert.equal(frames.length, 2, 'a store that opened is kept');
  c.dispose();
});

test('cancelling a get sends elffuss-model-cancel and rejects with aborted', async () => {
  const w = world({ handler(msg, reply) { if (msg.type === 'elffuss-model-get') reply({ kind: 'progress', loaded: 1, total: 10 }); } });
  const c = createStoreClient({ document: w.document });
  const ac = new AbortController();
  const p = c.get('https://x/big', { bytes: 10, signal: ac.signal });
  await new Promise(r => setTimeout(r, 10));
  w.intruder({ id: 1, kind: 'file', file: new Blob([new Uint8Array(10)]) });
  assert.deepEqual(c.pending(), ['https://x/big']);
  ac.abort();
  await assert.rejects(p, { code: 'aborted' });
  assert.ok(w.sent.some(s => s.msg.type === 'elffuss-model-cancel' && s.msg.url === 'https://x/big'));
  assert.deepEqual(c.pending(), []);
  c.dispose();
});
