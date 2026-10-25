// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The publication sweep: every rule catches its bait and lets a clean line pass,
// and the prose filter keeps code constants (timeouts) out of the timing rule.
// Baits are assembled at run time so that this file stays clean itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { staticRules, machineRules, selfTest, sweepText, sweepBinary, proseOf } from '../../scripts/sweep.mjs';

const j = (...p) => p.join('');

test('every static rule catches its bait and passes its clean line', () => {
  assert.deepEqual(selfTest(staticRules()), []);
});

test('machine rules: user name, host name, cache path and private terms', () => {
  const rules = machineRules({ username: j('some', 'body'), host: j('Bench', 'Box.local'), cachePath: j('/', 'Vol', 'umes/', 'Disk', 'X/cache-dir'), privateFile: undefined });
  assert.deepEqual(selfTest(rules), []);
  const ids = rules.map(r => r.id);
  assert.ok(ids.includes('user-name') && ids.includes('host-name') && ids.includes('cache-path'));
  assert.equal(sweepText(j('see /x/', 'DiskX', '/y'), '.md', rules).length, 1);
});

test('the bare processor word is caught; WebGPU and API names are not', () => {
  const rules = staticRules().filter(r => r.id === 'hardware');
  assert.equal(sweepText(j('needs a ', 'G', 'PU'), '.md', rules).length, 1);
  assert.equal(sweepText('needs WebGPU; navigator.gpu.requestAdapter(); GPUAdapter', '.md', rules).length, 0);
});

test('timings: prose and comments are swept, code constants are not', () => {
  const rules = staticRules().filter(r => r.id === 'timing');
  const code = 'const IDLE = 30000; setTimeout(f, 8000)\n// waits until the broker answers\n';
  assert.equal(sweepText(code, '.js', rules).length, 0);
  const comment = j('// this takes 4 ', 'seconds on a laptop');
  assert.equal(sweepText(comment, '.js', rules).length, 1);
  assert.equal(sweepText(j('Loads in 2 ', 'min.'), '.md', rules).length, 1);
});

test('proseOf keeps comments and line numbers, drops code', () => {
  const src = 'a = 1 // one\n/* two\nthree */ b = 2\nc = "https://x"';
  const p = proseOf(src, '.js').split('\n');
  assert.equal(p.length, 4);
  assert.match(p[0], /one/);
  assert.match(p[1], /two/);
  assert.match(p[2], /three/);
  assert.equal(p[3], '');
});

test('binaries are swept for the user name in latin1 and UTF-16', () => {
  const rules = machineRules({ username: j('some', 'body'), host: '', cachePath: undefined, privateFile: undefined });
  assert.equal(sweepBinary(Buffer.from(j('\0\0/x/some', 'body/y\0')), rules).length, 1);
  assert.equal(sweepBinary(Buffer.from(j('some', 'body'), 'utf16le'), rules).length, 1);
  assert.equal(sweepBinary(Buffer.from('\0\0clean\0'), rules).length, 0);
});

test('internal names and model servers that are not public', () => {
  const rules = staticRules().filter(r => r.id === 'internal');
  assert.equal(sweepText(j('see https://', 'm2', '.elffuss.com/a'), '.md', rules).length, 1);
  assert.equal(sweepText('see https://models.elffuss.com/ and https://ocr.elffuss.com/', '.md', rules).length, 0);
});
