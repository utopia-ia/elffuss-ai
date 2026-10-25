// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The TIFF decoder of the ocr site against files written by libtiff (an
// independent encoder): every fax mode (Group 4, Group 3 one- and
// two-dimensional, byte-aligned end-of-line codes, bit order reversed, several
// strips), PackBits, LZW and Deflate with and without the predictor, tiles,
// separate planes, big-endian files, 16-bit samples, palette (compared with
// libtiff's own decoding), the orientation tag and two pages in one file. The
// expected pixels are recomputed from the patterns the files were made from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tiffPages, decodeTiffPage, decodeCcitt, unpackBits, unLzw, reverseBits, orient } from '../../apps/ocr/tiff.js';
import { bilevel, grey, colour, grey16 } from './ocr-tiff-patterns.mjs';

const DIR = fileURLToPath(new URL('../fixtures/ocr/tiff/', import.meta.url));
const load = async (name, page = 0) => { const b = readFileSync(join(DIR, `${name}.tif`)); const t = tiffPages(b); return decodeTiffPage(b, t.pages[page]); };

function sameGrey(img, pat, label) {
  assert.deepEqual([img.width, img.height], [pat.width, pat.height], `${label}: size`);
  for (let i = 0; i < pat.width * pat.height; i++) {
    const v = img.data[i * 4];
    if (v !== pat.data[i] || img.data[i * 4 + 1] !== v || img.data[i * 4 + 3] !== 255) assert.fail(`${label}: pixel ${i % pat.width},${Math.floor(i / pat.width)} is ${v}, want ${pat.data[i]}`);
  }
}

test('fax: Group 4, Group 3 (1D, 2D, byte-aligned EOL, several strips), bit order reversed, PackBits', async () => {
  const bl = bilevel();
  const want = { width: bl.width, height: bl.height, data: bl.data.map(v => (v ? 0 : 255)) };
  for (const name of ['bl-g4', 'bl-g4-lsb', 'bl-g3-1d', 'bl-g3-2d', 'bl-g3-fill', 'bl-g3-strips', 'bl-packbits']) sameGrey(await load(name), want, name);
});

test('grey and colour: LZW and Deflate with the predictor, tiles, big-endian, separate planes', async () => {
  const gr = grey();
  for (const name of ['gr-lzw2', 'gr-zip2', 'gr-tiles', 'gr-be']) sameGrey(await load(name), gr, name);
  const co = colour();
  for (const name of ['co-sep', 'co-tiles', 'co-be2']) {
    const img = await load(name);
    assert.deepEqual([img.width, img.height], [co.width, co.height], name);
    for (let i = 0; i < co.width * co.height; i++) for (let c = 0; c < 3; c++) if (img.data[i * 4 + c] !== co.data[i * 3 + c]) assert.fail(`${name}: pixel ${i} channel ${c}`);
  }
});

test('16-bit samples are scaled to 8 bits', async () => {
  const g = grey16();
  sameGrey(await load('g16-lzw2'), { width: g.width, height: g.height, data: Array.from(g.data, v => Math.round((v * 255) / 65535)) }, 'g16-lzw2');
});

test('palette: the same colours libtiff gives', async () => {
  const pal = await load('co-palette');
  const ref = await load('co-palette-rgba');
  assert.deepEqual([pal.width, pal.height], [ref.width, ref.height]);
  assert.deepEqual(Buffer.from(pal.data), Buffer.from(ref.data));
});

test('orientation 6 is turned upright', async () => {
  const gr = grey();
  const img = await load('gr-orient6');
  assert.deepEqual([img.width, img.height], [gr.height, gr.width]);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4] !== gr.data[(gr.height - 1 - x) * gr.width + y]) assert.fail(`at ${x},${y}`);
  }
  const small = { width: 2, height: 1, data: new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255]) };
  assert.deepEqual([...orient(small, 3).data].filter((_, i) => i % 4 === 0), [2, 1]);
  assert.deepEqual([orient(small, 8).width, orient(small, 8).height], [1, 2]);
});

test('two pages in one file', async () => {
  const b = readFileSync(join(DIR, 'multi.tif'));
  const t = tiffPages(b);
  assert.equal(t.pages.length, 2);
  const bl = bilevel();
  sameGrey(await decodeTiffPage(b, t.pages[0]), { width: bl.width, height: bl.height, data: bl.data.map(v => (v ? 0 : 255)) }, 'page 1');
  sameGrey(await decodeTiffPage(b, t.pages[1]), grey(), 'page 2');
});

test('what is not a TIFF it reads is refused with the right code', async () => {
  assert.throws(() => tiffPages(new Uint8Array([1, 2, 3])), e => e.code === 'decode-failed');
  assert.throws(() => tiffPages(Buffer.from('II+\0\x08\0\0\0', 'latin1')), e => e.code === 'unsupported-format', 'BigTIFF');
  assert.throws(() => tiffPages(Buffer.from('PK\x03\x04xxxx', 'latin1')), e => e.code === 'decode-failed');
  const b = readFileSync(join(DIR, 'gr-lzw2.tif'));
  const page = tiffPages(b).pages[0];
  await assert.rejects(decodeTiffPage(b, { ...page, compression: 34712 }), e => e.code === 'unsupported-format');
  await assert.rejects(decodeTiffPage(b, { ...page, sampleFormat: 3 }), e => e.code === 'unsupported-format');
  await assert.rejects(decodeTiffPage(b, { ...page, width: 20000, height: 20000 }), e => e.code === 'too-large');
  await assert.rejects(decodeTiffPage(b.subarray(0, 200), page), e => e.code === 'decode-failed', 'cut short');
  await assert.rejects(decodeTiffPage(b, { ...page, compression: 7 }), e => e.code === 'unsupported-format', 'JPEG without a decoder');
});

test('the small decoders: PackBits, LZW, bit order, modified Huffman rows', () => {
  assert.deepEqual([...unpackBits(new Uint8Array([2, 1, 2, 3, 0xfd, 9, 0x80, 0, 4]), 8)], [1, 2, 3, 9, 9, 9, 9, 4]);
  // LZW of "ABABABA": clear, A, B, AB, ABA, end (9-bit codes, most significant bit first).
  const codes = [256, 65, 66, 258, 260, 257];
  const bits = codes.map(c => c.toString(2).padStart(9, '0')).join('');
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') bytes[i >> 3] |= 0x80 >> (i & 7);
  assert.equal(Buffer.from(unLzw(bytes, 7)).toString('latin1'), 'ABABABA');
  assert.deepEqual([...reverseBits(new Uint8Array([0b10000000, 0b00000110]))], [0b00000001, 0b01100000]);
  // Width 8: white 3 (1000), black 2 (11), white 3 (1000); each row starts on a byte.
  const row = [0b10001110, 0b00000000];
  const px = decodeCcitt(new Uint8Array([...row, ...row]), 8, 2, 2, 0);
  assert.deepEqual([...px], [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0]);
  assert.throws(() => decodeCcitt(new Uint8Array([0, 0, 0, 0]), 8, 1, 2, 0), e => e.code === 'decode-failed');
});
