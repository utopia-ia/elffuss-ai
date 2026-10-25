// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Model ids and Hub URLs live in the registry, never in the code:
//  1. no Hub host or resolve path outside sdk/core/hub-url.js;
//  2. every literal shaped like a model id exists in tasks.json (fails, does not warn);
//  3. no literal starts with the owner of a registry repo outside registry/;
//  4. the branch revision of the Hub appears nowhere but in the tests of the
//     rewrite to the pinned commit (hub-url and store-fetch).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const reg = JSON.parse(readFileSync(join(ROOT, 'registry/tasks.json'), 'utf8'));
const CODE_DIRS = ['sdk', 'apps', 'catalog', 'shared', 'scripts', 'deploy'];
const TEXT = /\.(m?js|json|html|css|md|sh|conf|txt)$/;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (TEXT.test(e.name)) out.push(p);
  }
  return out;
}
const rel = p => relative(ROOT, p).split(sep).join('/');
const codeFiles = CODE_DIRS.flatMap(d => walk(join(ROOT, d))).map(p => ({ path: rel(p), text: readFileSync(p, 'utf8') }));
const hubHost = ['hugging', 'face.co'].join('');
const resolveSeg = ['res', 'olve/'].join('');

test('1. the Hub host and its resolve path only appear in sdk/core/hub-url.js', () => {
  const hits = codeFiles.filter(f => f.path !== 'sdk/core/hub-url.js' && (f.text.includes(hubHost) || f.text.includes(resolveSeg)));
  assert.deepEqual(hits.map(f => f.path), []);
});

test('2. every model-id-shaped literal is in tasks.json', () => {
  const re = /(['"`])((?:remove-bg|depth|detect|ocr)\/[a-z0-9][a-z0-9.\-]*)\1/g;
  const unknown = [];
  for (const f of codeFiles) {
    for (const m of f.text.matchAll(re)) if (!reg.models[m[2]]) unknown.push(`${f.path}: ${m[2]}`);
  }
  assert.deepEqual(unknown, []);
});

test('3. no literal starts with the owner of a registry repo outside registry/', () => {
  const owners = [...new Set(Object.values(reg.models).flatMap(m => Object.values(m.parts).map(p => p.repo.split('/')[0])))];
  assert.ok(owners.length >= 2);
  const hits = [];
  for (const f of codeFiles) {
    for (const o of owners) if (new RegExp(`['"\`]${o}/`).test(f.text)) hits.push(`${f.path}: ${o}/`);
  }
  assert.deepEqual(hits, []);
});

test('4. the branch revision of the Hub is spelled only in the rewrite tests', () => {
  const needle = [resolveSeg, 'main'].join('');
  const files = execFileSync('/usr/bin/git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n').filter(f => f && !f.startsWith('vendor/') && existsSync(join(ROOT, f)) && TEXT.test(f));
  const allowed = new Set(['tests/unit/hub-url.test.mjs', 'tests/unit/store-fetch.test.mjs']);
  const hits = files.filter(f => !allowed.has(f) && readFileSync(join(ROOT, f), 'utf8').includes(needle));
  assert.deepEqual(hits, []);
});
