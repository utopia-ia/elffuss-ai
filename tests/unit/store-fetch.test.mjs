// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// storeFetch, the only way out for Transformers.js, with a fake store: every Hub
// URL of the model is served from the pinned commit, probes are answered here
// with the registry's size, unknown paths get 404, and nothing reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createStoreFetch } from '../../sdk/core/tf-env.js';
import { createVerifiedMemo } from '../../sdk/core/integrity.js';
import { variantFiles } from '../../sdk/core/registry.js';
import { chooseVariant } from '../../sdk/core/device.js';
import { HUB_ORIGIN, pinnedUrl } from '../../sdk/core/hub-url.js';

const reg = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));
const model = reg.models['depth/depth-anything-v2-small'];
const part = model.parts.main;
const choice = chooseVariant(model, 'wasm', { available: false });
const files = variantFiles(model, choice.variant);
const at = (rev, path) => `${HUB_ORIGIN}/${part.repo}/resolve/${rev}/${path}`;

// Fake bytes whose git blob hash is not the registry's: integrity must catch it.
// For files we serve "correctly" we patch the registry copy with the fake's hash.
function fakeStore() {
  const gets = [];
  const content = new Map();
  return {
    gets,
    content,
    has: async () => false,
    get: async (url, { bytes }) => { gets.push({ url, bytes }); const b = content.get(url) ?? new Uint8Array(bytes); return new Blob([b]); },
  };
}
const gitOid = b => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');

function modelWithHashes(store) {
  // A copy of the model whose small files are hashed as the fake store serves them.
  const m = structuredClone(model);
  for (const [path, meta] of Object.entries(m.parts.main.files)) {
    if (meta.gitOid) {
      const b = Buffer.from(`{"fake":"${path}"}`.padEnd(meta.size, ' '));
      store.content.set(pinnedUrl(part.repo, part.revision, path), b);
      meta.gitOid = gitOid(b);
    } else {
      const b = Buffer.alloc(meta.size, 7);
      store.content.set(pinnedUrl(part.repo, part.revision, path), b);
      meta.sha256 = createHash('sha256').update(b).digest('hex');
    }
  }
  return m;
}

const noNetwork = async () => { throw new Error('network used'); };

test('branch-head and pinned URLs are both served from the pinned commit', async () => {
  const store = fakeStore();
  const m = modelWithHashes(store);
  const f = createStoreFetch({ model: m, files: variantFiles(m, choice.variant), store, memo: createVerifiedMemo({ indexedDB: null }), baseFetch: noNetwork });
  const r1 = await f(at('main', 'config.json'));
  assert.equal(r1.status, 200);
  const r2 = await f(new URL(at(part.revision, 'config.json')));
  assert.equal(r2.status, 200);
  assert.equal(await r1.text(), await r2.text());
  assert.deepEqual(store.gets.map(g => g.url), [pinnedUrl(part.repo, part.revision, 'config.json')], 'read from the store once, at the pinned URL');
  assert.equal(store.gets[0].bytes, model.parts.main.files['config.json'].size, 'always with its exact size');
});

test('a one-byte probe is answered here, with the registry size, without the store', async () => {
  const store = fakeStore();
  const f = createStoreFetch({ model, files, store, memo: createVerifiedMemo({ indexedDB: null }), baseFetch: noNetwork });
  const r = await f(at('main', 'preprocessor_config.json'), { method: 'GET', headers: new Headers({ Range: 'bytes=0-0' }), cache: 'no-store' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), `bytes 0-0/${part.files['preprocessor_config.json'].size}`);
  assert.equal(store.gets.length, 0);
  await assert.rejects(f(at('main', 'config.json'), { headers: { range: 'bytes=10-20' } }), { code: 'not-in-registry' });
});

test('paths the registry does not list, and weights of other variants, are 404', async () => {
  const store = fakeStore();
  const f = createStoreFetch({ model, files, store, memo: createVerifiedMemo({ indexedDB: null }), baseFetch: noNetwork });
  assert.equal((await f(at('main', 'tokenizer.json'))).status, 404);
  assert.equal((await f(at('main', 'onnx/model_quantized.onnx_data'))).status, 404);
  assert.equal((await f(at(part.revision, 'onnx/model_fp16.onnx'))).status, 404, 'fp16 is not the WebAssembly variant');
  assert.equal(store.gets.length, 0);
});

test('other revisions, other repos, other hosts and queries are refused', async () => {
  const store = fakeStore();
  const f = createStoreFetch({ model, files, store, memo: createVerifiedMemo({ indexedDB: null }), baseFetch: noNetwork });
  await assert.rejects(f(at('f'.repeat(40), 'config.json')), { code: 'not-in-registry' });
  await assert.rejects(f(at('v1.0', 'config.json')), { code: 'not-in-registry' });
  await assert.rejects(f(`${HUB_ORIGIN}/someone/else/resolve/main/config.json`), { code: 'not-in-registry' });
  await assert.rejects(f('https://example.org/x.onnx'), { code: 'not-in-registry' });
  await assert.rejects(f(at('main', 'config.json') + '?download=true'), { code: 'not-in-registry' });
  await assert.rejects(f(`${HUB_ORIGIN}/api/models/${part.repo}`), { code: 'not-in-registry' });
  assert.equal(store.gets.length, 0);
});

test('a file that is not the pinned one fails with integrity', async () => {
  const store = fakeStore(); // serves zeros: the hashes of the real registry do not match
  const f = createStoreFetch({ model, files, store, memo: createVerifiedMemo({ indexedDB: null }), baseFetch: noNetwork });
  await assert.rejects(f(at('main', 'config.json')), { code: 'integrity' });
});

test('the weight of the chosen variant comes from the store with its size', async () => {
  const store = fakeStore();
  const m = modelWithHashes(store);
  const fs = variantFiles(m, choice.variant);
  const f = createStoreFetch({ model: m, files: fs, store, memo: createVerifiedMemo({ indexedDB: null }), baseFetch: noNetwork });
  const w = fs.find(x => x.path.endsWith('.onnx'));
  const r = await f(at('main', w.path));
  assert.equal(r.status, 200);
  assert.equal(Number(r.headers.get('content-length')), w.size);
  assert.equal((await r.arrayBuffer()).byteLength, w.size);
});
