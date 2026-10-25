#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Puts the model-store page the browser tests serve into the test cache. It is
// the broker page that models.elffuss.com serves today plus the proposed
// read-only permission for the tool sites; it is not committed here because it
// belongs to the broker's own repository.
//
//   ELFFUSS_AI_CACHE=<dir> node scripts/make-broker-fixture.mjs --base <server/broker/index.html> --patch <patch file>
//
// Both inputs are checked: the base by its sha256 and the result by its sha256,
// both in tests/fixtures/broker/SOURCE.json, and the result must contain the two
// blocks of tests/fixtures/broker/tools-permission.js verbatim.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests', 'fixtures', 'broker');
const sha = b => createHash('sha256').update(b).digest('hex');

/** The verbatim blocks of tools-permission.js. */
export function permissionBlocks(text = readFileSync(join(FIX, 'tools-permission.js'), 'utf8')) {
  return [...text.matchAll(/\/\/ <extract>\n([\s\S]*?)\/\/ <\/extract>\n/g)].map(m => m[1]);
}

/** Where the harness reads the broker page from. */
export function brokerPath(cache = process.env.ELFFUSS_AI_CACHE) {
  if (!cache) throw new Error('set ELFFUSS_AI_CACHE');
  return join(cache, 'broker', 'index.html');
}

/** Check a broker page against SOURCE.json and the permission blocks. Returns problems. */
export function checkBroker(buf) {
  const source = JSON.parse(readFileSync(join(FIX, 'SOURCE.json'), 'utf8'));
  const problems = [];
  if (sha(buf) !== source.sha256) problems.push('the broker page is not the pinned one (sha256 differs from tests/fixtures/broker/SOURCE.json)');
  const text = buf.toString('utf8');
  for (const b of permissionBlocks()) if (!text.includes(b)) problems.push('the broker page lacks a block of tools-permission.js');
  return problems;
}

function main(argv) {
  const arg = k => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
  const base = arg('--base'), patch = arg('--patch');
  if (!base || !patch) { console.error('usage: make-broker-fixture.mjs --base <server/broker/index.html> --patch <patch>'); return 2; }
  const source = JSON.parse(readFileSync(join(FIX, 'SOURCE.json'), 'utf8'));
  const baseBuf = readFileSync(base);
  if (sha(baseBuf) !== source.baseSha256) { console.error('✗ the base page is not the one this fixture starts from'); return 1; }
  const tmp = mkdtempSync(join(tmpdir(), 'broker-fixture-'));
  try {
    mkdirSync(join(tmp, 'server', 'broker'), { recursive: true });
    writeFileSync(join(tmp, 'server', 'broker', 'index.html'), baseBuf);
    execFileSync('/usr/bin/git', ['apply', '--include=server/broker/index.html', patch], { cwd: tmp, stdio: 'inherit' });
    const out = readFileSync(join(tmp, 'server', 'broker', 'index.html'));
    const problems = checkBroker(out);
    for (const p of problems) console.error('✗ ' + p);
    if (problems.length) return 1;
    const dst = brokerPath();
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, out);
    console.log(`✓ broker page written to $ELFFUSS_AI_CACHE/broker/index.html (sha256 ${source.sha256.slice(0, 16)}…)`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
