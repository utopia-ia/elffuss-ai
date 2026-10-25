// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The pure parts of the cutout site: the name of the saved PNG and the
// geometry of the before/after comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import { outputName } from '../../apps/cutout/names.js';
import { fitWithin, splitAt, valueAt, cellSize, PREVIEW_SIDE } from '../../apps/cutout/compare.js';

test('the saved PNG is named after the image, with the suffix of the language', () => {
  assert.equal(outputName('foto.jpg', 'sin-fondo'), 'foto-sin-fondo.png');
  assert.equal(outputName('pasted-1.png', 'no-background'), 'pasted-1-no-background.png');
  assert.equal(outputName('archive.tar.gz', 'x'), 'archive.tar-x.png', 'only the last extension goes');
  assert.equal(outputName('sin extensión', 'x'), 'sin extensión-x.png');
  assert.equal(outputName('../../etc/passwd', 'x'), 'passwd-x.png', 'no folders');
  assert.equal(outputName('C:\\fotos\\perro.webp', 'x'), 'perro-x.png');
  assert.equal(outputName('a<b>:c"d|e?f*g\u0007.png', 'x'), 'abcdefg-x.png', 'characters file systems refuse are dropped');
  assert.equal(outputName('.png', 'x'), 'image-x.png');
  assert.equal(outputName('', 'x', 'imagen'), 'imagen-x.png');
  assert.equal(outputName(undefined, 'x'), 'image-x.png');
  assert.equal(outputName('Ñandú.jpeg', 'sin-fondo'), 'Ñandú-sin-fondo.png');
  assert.equal(outputName('n'.repeat(300) + '.jpg', 'x').length, 100 + '-x.png'.length, 'long names are cut');
});

test('the comparison canvas keeps the ratio and never grows past its limit', () => {
  assert.deepEqual(fitWithin(960, 640), { width: 960, height: 640 }, 'small pictures keep their size');
  assert.deepEqual(fitWithin(4000, 3000), { width: PREVIEW_SIDE, height: 1200 });
  assert.deepEqual(fitWithin(3000, 6000), { width: 800, height: PREVIEW_SIDE });
  assert.deepEqual(fitWithin(1, 10000), { width: 1, height: PREVIEW_SIDE }, 'never zero');
  assert.deepEqual(fitWithin(100, 50, 40), { width: 40, height: 20 });
});

test('slider values and pointer positions map to the split', () => {
  assert.equal(splitAt(50, 960), 480);
  assert.equal(splitAt(0, 960), 0);
  assert.equal(splitAt(100, 960), 960);
  assert.equal(splitAt(150, 960), 960, 'clamped');
  assert.equal(splitAt(-5, 960), 0, 'clamped');
  assert.equal(splitAt('25', 400), 100, 'an input value is a string');
  assert.equal(splitAt('abc', 400), 200, 'not a number: the middle');
  assert.equal(valueAt(150, 100, 200), 25);
  assert.equal(valueAt(50, 100, 200), 0, 'left of the box');
  assert.equal(valueAt(400, 100, 200), 100, 'right of the box');
  assert.equal(valueAt(150, 100, 0), 50, 'a box with no width');
  assert.equal(cellSize(960, 640), 20);
  assert.equal(cellSize(100, 50), 6, 'never tiny');
});
