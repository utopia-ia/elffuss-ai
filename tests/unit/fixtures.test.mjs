// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Test fixtures: every file is accounted for in tests/fixtures/SOURCES.json with
// its sha256 and a licence we may use (CC0, public domain or own work), and none
// is one of runonweb's sample files (whose hashes alone are kept).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIX = join(ROOT, 'tests', 'fixtures');
const sources = JSON.parse(readFileSync(join(FIX, 'SOURCES.json'), 'utf8'));
const deny = new Set(readFileSync(join(FIX, 'denylist-runonweb-samples.sha256'), 'utf8').split('\n').filter(l => /^[0-9a-f]{64}\s/.test(l)).map(l => l.slice(0, 64)));
const LICENSES = ['CC0-1.0', 'public-domain', 'own-work'];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (!e.name.startsWith('._') && e.name !== '.DS_Store') out.push(p);
  }
  return out;
}
const rel = p => relative(ROOT, p).split(sep).join('/');
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const own = new Set(['tests/fixtures/SOURCES.json', 'tests/fixtures/denylist-runonweb-samples.sha256']);

test('the deny-list holds the 34 sample hashes', () => {
  assert.equal(deny.size, 34);
});

test('every fixture is listed, with its hash and an allowed licence', () => {
  const listed = new Map(sources.files.map(f => [f.path, f]));
  for (const p of walk(FIX)) {
    const r = rel(p);
    if (own.has(r) || r.startsWith('tests/fixtures/broker/')) continue;
    const f = listed.get(r);
    assert.ok(f, `${r} is not in SOURCES.json`);
    assert.equal(sha(p), f.sha256, `${r}: sha256`);
    assert.ok(LICENSES.includes(f.license), `${r}: licence ${f.license}`);
    if (f.license === 'own-work') assert.ok(f.source?.script && existsSync(join(ROOT, f.source.script)), `${r}: own work names the script that makes it`);
    else assert.ok(f.source?.url && f.source?.author, `${r}: a photo needs its page and its author`);
    if (/(^|\/)golden-/.test(r)) assert.ok(f.model && /^[0-9a-f]{40}$/.test(f.revision || '') && ['webgpu', 'wasm'].includes(f.device), `${r}: a reference names model, revision and backend`);
    assert.ok(f.purpose, `${r}: what it is for`);
  }
  for (const f of sources.files) assert.ok(existsSync(join(ROOT, f.path)), `${f.path} is listed but missing`);
});

test('no fixture is one of the runonweb samples', () => {
  for (const p of walk(FIX)) assert.equal(deny.has(sha(p)), false, `${rel(p)} is a runonweb sample`);
});
