// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The documentation is generated from its sources (JSDoc, registry, sites) and
// what is committed is exactly what the generator gives today.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, typed, extract } from '../../scripts/build-docs.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

test('every generated document matches its sources', () => {
  for (const [p, text] of generate()) {
    assert.ok(existsSync(join(ROOT, p)), `${p} is missing`);
    assert.equal(readFileSync(join(ROOT, p), 'utf8'), text, `${p} is stale: run node scripts/build-docs.mjs`);
  }
});

test('the JSDoc reader handles nested types and default values', () => {
  assert.deepEqual(typed('{{ a?: { b: number } }} [opts] the options'), { type: '{ a?: { b: number } }', name: '[opts]', text: 'the options' });
  const e = extract('/** Doc. @param {number} x the x */\nexport function f(x = g(1), { y } = {}) {}\n/** A class. */\nexport class C {\n  /** Size. */\n  get size() {}\n  /** Go. */\n  go(a) {}\n  #hidden() {}\n}\n');
  assert.equal(e[0].params, 'x = g(1), { y } = {}');
  assert.deepEqual(e[1].members.map(m => m.name), ['size', 'go']);
});

test('the docs speak of every task and site', () => {
  const llms = readFileSync(join(ROOT, 'docs', 'llms.txt'), 'utf8');
  for (const h of ['cutout', 'ocr', 'detect', 'depth', 'tools']) assert.match(llms, new RegExp(`https://${h}\\.elffuss\\.com/`));
  const models = readFileSync(join(ROOT, 'docs', 'MODELS.md'), 'utf8');
  for (const id of ['remove-bg/ben2', 'depth/depth-anything-v2-small', 'detect/rfdetr-nano', 'ocr/pp-ocrv6-small']) assert.ok(models.includes(id), id);
});
