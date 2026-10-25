// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The vendored runtimes are exactly the pinned ones, and the build's rewrite of
// Transformers.js changes its two ONNX Runtime imports and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { check, readManifest, SPECS } from '../../scripts/vendor.mjs';
import { rewriteTransformers, ORT_IMPORTS } from '../../scripts/lib/rewrite-transformers.mjs';
import { PINS, VENDOR_DIRS } from '../../sdk/core/runtime-pins.js';
import { ORT_VARIANTS, ortSpecifierFromTransformers, runtimeUrls } from '../../sdk/core/runtimes.js';

const root = new URL('../../', import.meta.url);

test('vendor/ matches the manifest byte for byte, and the pins match it', () => {
  assert.deepEqual(check(), []);
});

test('exact versions, every package has a licence file, nothing from a CDN', () => {
  const m = readManifest();
  for (const [id, e] of Object.entries(m.packages)) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/, id);
    assert.ok(Object.keys(e.licenses).length > 0, id + ' has no licence file');
    assert.ok(e.tarball.startsWith('https://registry.npmjs.org/'), id);
    assert.equal(PINS[SPECS[e.name].key], e.version);
    assert.equal(VENDOR_DIRS[SPECS[e.name].key], id);
  }
  for (const v of Object.values(ORT_VARIANTS)) {
    for (const f of Object.values(v)) assert.ok(m.packages[VENDOR_DIRS.onnxruntimeWeb].files[f], f + ' is not vendored');
  }
});

test('the Transformers.js rewrite touches exactly the two ONNX Runtime imports', () => {
  const src = readFileSync(new URL(`vendor/${VENDOR_DIRS.transformers}/dist/transformers.web.min.js`, root), 'utf8');
  for (const variant of Object.keys(ORT_VARIANTS)) {
    const spec = ortSpecifierFromTransformers(variant);
    const out = rewriteTransformers(src, spec);
    assert.equal(out.split(`from"${spec}"`).length - 1, 2);
    for (const clause of ORT_IMPORTS) assert.equal(out.includes(clause), false);
    assert.equal(out.length, src.length + 2 * spec.length - ORT_IMPORTS.reduce((s, c) => s + c.length, 0) + 2 * 'from""'.length);
  }
  assert.throws(() => rewriteTransformers(src.replace(ORT_IMPORTS[1], ''), ortSpecifierFromTransformers('wasm')), /exactly one/);
  assert.throws(() => rewriteTransformers(src + ORT_IMPORTS[0], ortSpecifierFromTransformers('wasm')), /exactly one/);
});

test('runtime URLs stay under /vendor/ of the same origin', () => {
  const u = runtimeUrls({ variant: 'wasm', pdfjs: true });
  for (const v of [u.ortBundle, u.ortMjs, u.ortWasm, u.transformers, ...Object.values(u.pdfjs)]) assert.match(v, /^\/vendor\//);
  assert.match(u.transformers, /\+ort1\.30\.0-wasm\//);
  assert.throws(() => runtimeUrls({ variant: 'jsep' }));
});

test('every pinned file is committed, not left out by an ignore rule', () => {
  const tracked = new Set(execFileSync('/usr/bin/git', ['-C', new URL('.', root).pathname, 'ls-files', 'vendor'], { encoding: 'utf8' }).split('\n').filter(Boolean));
  const m = readManifest();
  for (const [id, e] of Object.entries(m.packages)) {
    for (const p of Object.keys({ ...e.files, ...e.licenses })) assert.ok(tracked.has(`vendor/${id}/${p}`), `vendor/${id}/${p} is not committed`);
  }
  assert.ok(tracked.has('vendor/manifest.json'));
});
