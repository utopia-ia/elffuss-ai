// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The vendored runtimes are exactly the pinned ones, and the build's rewrite of
// Transformers.js changes its two ONNX Runtime imports and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { check, readManifest, readEngine, engineDir, relativeImports, engineClosure, SPECS, ENGINE } from '../../scripts/vendor.mjs';
import { rewriteTransformers, ORT_IMPORTS, MODIFIED_NOTICE } from '../../scripts/lib/rewrite-transformers.mjs';
import { PINS, VENDOR_DIRS } from '../../sdk/core/runtime-pins.js';
import { ORT_VARIANTS, ortSpecifierFromTransformers, runtimeUrls, ENGINE_ENTRY, ENGINE_ENTRIES } from '../../sdk/core/runtimes.js';

const root = new URL('../../', import.meta.url);

test('vendor/ matches the manifest byte for byte, and the pins match it', () => {
  const problems = check();
  const hint = problems.some(p => p.endsWith(': missing')) ? ' (the runtimes are not in git: run `node scripts/vendor.mjs --fetch`, or `npm test`, which fetches them)' : '';
  assert.deepEqual(problems, [], 'vendor/ differs from vendor/manifest.json' + hint);
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

test('the Transformers.js rewrite touches exactly the two ONNX Runtime imports, and says so on its first line', () => {
  const src = readFileSync(new URL(`vendor/${VENDOR_DIRS.transformers}/dist/transformers.web.min.js`, root), 'utf8');
  for (const variant of Object.keys(ORT_VARIANTS)) {
    const spec = ortSpecifierFromTransformers(variant);
    const out = rewriteTransformers(src, spec);
    assert.ok(out.startsWith(MODIFIED_NOTICE), 'the modified file starts with its notice');
    assert.match(MODIFIED_NOTICE, /^\/\*! Modified by UtopiaIA[^\n]*\*\/\n$/, 'one comment line');
    assert.equal(out.split(`from"${spec}"`).length - 1, 2);
    for (const clause of ORT_IMPORTS) assert.equal(out.includes(clause), false);
    assert.equal(out.length, MODIFIED_NOTICE.length + src.length + 2 * spec.length - ORT_IMPORTS.reduce((s, c) => s + c.length, 0) + 2 * 'from""'.length);
  }
  assert.throws(() => rewriteTransformers(src.replace(ORT_IMPORTS[1], ''), ortSpecifierFromTransformers('wasm')), /exactly one/);
  assert.throws(() => rewriteTransformers(src + ORT_IMPORTS[0], ortSpecifierFromTransformers('wasm')), /exactly one/);
});

test('runtime URLs stay under /vendor/ of the same origin', () => {
  const u = runtimeUrls({ variant: 'wasm', pdfjs: true });
  for (const v of [u.ortBundle, u.ortMjs, u.ortWasm, u.transformers, u.engine, ...Object.values(u.pdfjs)]) assert.match(v, /^\/vendor\//);
  assert.equal(u.engine, `/vendor/${VENDOR_DIRS.engine}/${ENGINE_ENTRY}`);
  assert.match(u.transformers, /\+ort1\.30\.0-wasm\//);
  assert.throws(() => runtimeUrls({ variant: 'jsep' }));
});

test('only the pins are committed under vendor/: the runtimes are fetched by them', () => {
  const dir = new URL('.', root).pathname;
  const tracked = execFileSync('/usr/bin/git', ['-C', dir, 'ls-files', 'vendor'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of tracked) assert.ok(['vendor/manifest.json', 'vendor/engine.json'].includes(f), f);
  assert.ok(tracked.includes('vendor/manifest.json'));
  const engine = readEngine();
  for (const p of Object.keys(engine.files)) execFileSync('/usr/bin/git', ['-C', dir, 'check-ignore', '-q', '--no-index', `vendor/${engineDir(engine)}/${p}`]);
  assert.throws(() => execFileSync('/usr/bin/git', ['-C', dir, 'check-ignore', '-q', '--no-index', 'vendor/engine.json'], { stdio: 'ignore' }));
  const m = readManifest();
  for (const [id, e] of Object.entries(m.packages)) {
    for (const p of Object.keys({ ...e.files, ...e.licenses })) {
      // git check-ignore exits 0 when the path is ignored.
      execFileSync('/usr/bin/git', ['-C', dir, 'check-ignore', '-q', '--no-index', `vendor/${id}/${p}`]);
    }
  }
  assert.throws(() => execFileSync('/usr/bin/git', ['-C', dir, 'check-ignore', '-q', '--no-index', 'vendor/manifest.json'], { stdio: 'ignore' }));
});

test('the engine: pinned at a full commit of its public branch, its entries are what the sites import, and its pins are in runtime-pins.js', () => {
  const e = readEngine();
  assert.ok(e, 'vendor/engine.json');
  assert.match(e.commit, /^[0-9a-f]{40}$/);
  assert.equal(e.name, ENGINE.name);
  assert.equal(e.branch, ENGINE.branch);
  assert.equal(e.license, 'Apache-2.0');
  assert.deepEqual(e.entries, Object.values(ENGINE_ENTRIES));
  assert.ok(e.entries.includes(ENGINE_ENTRY));
  for (const en of e.entries) assert.equal(en.slice(0, en.lastIndexOf('/')), ENGINE_ENTRY.slice(0, ENGINE_ENTRY.lastIndexOf('/')), `${en} beside ${ENGINE_ENTRY}`);
  assert.equal(VENDOR_DIRS.engine, engineDir(e));
  assert.equal(PINS.engine, e.commit.slice(0, 12));
  for (const l of ENGINE.licenses) assert.ok(e.files[l], l + ' is pinned with the files');
  for (const [p, m] of Object.entries(e.files)) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/, p);
    assert.match(m.gitOid, /^[0-9a-f]{40}$/, p);
  }
});

test('the engine: exactly the import closure of its entries, every file Apache-2.0 under our copyright', () => {
  const e = readEngine();
  const dir = new URL(`vendor/${engineDir(e)}/`, root);
  const read = p => readFileSync(new URL(p, dir));
  const closure = engineClosure(read, e.entries);
  assert.deepEqual([...closure.keys(), ...ENGINE.licenses].sort(), Object.keys(e.files).sort(), 'nothing missing, nothing extra');
  for (const p of closure.keys()) {
    const head = read(p).toString('utf8').split('\n').slice(0, 2).join('\n');
    assert.match(head, /^\/\/ SPDX-License-Identifier: Apache-2\.0( AND MIT)?\n\/\/ Copyright \(c\) 2026 UtopiaIA$/, p);
  }
  assert.match(read('LICENSE').toString('utf8'), /Apache License\s+Version 2\.0/);
});

test('relativeImports finds static imports, re-exports and literal dynamic imports, and nothing else', () => {
  const src = "import { a } from './a.js';\nexport { b } from \"../b.js\";\nconst m = await import('./c.js');\nimport './d.js';\nimport x from 'pkg';\nconst u = import(name);\nconst w = new Worker(new URL('./f.js', import.meta.url));\nconst g = new URL('./g.js', location.href);\n// from './e.js' in a comment is still a file";
  assert.deepEqual(relativeImports(src).sort(), ['../b.js', './a.js', './c.js', './d.js', './e.js', './f.js']);
  const files = { 'js/m.js': "import { x } from './x.js'; import('./y.js');", 'js/x.js': "export * from './y.js';", 'js/y.js': '' };
  assert.deepEqual([...engineClosure(p => Buffer.from(files[p]), 'js/m.js').keys()], ['js/m.js', 'js/x.js', 'js/y.js']);
});
