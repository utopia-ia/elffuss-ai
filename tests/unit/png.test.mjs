// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The canvas-free PNG writer keeps every sample as given (a canvas would store
// premultiplied alpha and change the colour of the half-transparent edge of a
// cut-out), at 8 and 16 bits, and its files read back with the PNG reader and
// with zlib's own inflate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePngSamples, decodePng } from '../../sdk/core/png.js';
import { encodePng } from '../../sdk/core/image-input.js';

test('RGBA with every alpha level comes back exactly, marked as sRGB', async () => {
  const width = 256, height = 3;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) for (let y = 0; y < height; y++) {
    const i = (y * width + x) * 4;
    data.set([(x * 7 + y) & 255, (255 - x) & 255, (x * 3) & 255, x], i); // alpha 0…255 along the row
  }
  const png = await encodePng({ width, height, data });
  assert.equal(png.type, 'image/png');
  const back = await decodePng(png);
  assert.deepEqual([back.width, back.height, back.channels, back.bitDepth, back.srgb], [width, height, 4, 8, true]);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(data), 'no premultiplication: half-transparent pixels keep their colour');
});

test('16-bit grey and 8-bit grey with alpha, read back sample for sample', async () => {
  const g16 = Uint16Array.from({ length: 50 * 4 }, (_, i) => (i * 1311) & 0xffff);
  const b16 = await decodePng(await encodePngSamples({ width: 50, height: 4, channels: 1, bitDepth: 16, data: g16 }));
  assert.deepEqual([b16.bitDepth, b16.channels, b16.srgb], [16, 1, false]);
  assert.deepEqual([...b16.data], [...g16]);
  const ga = Uint8Array.from({ length: 9 * 9 * 2 }, (_, i) => (i * 37) & 255);
  const bga = await decodePng(await encodePngSamples({ width: 9, height: 9, channels: 2, data: ga }));
  assert.deepEqual([...bga.data], [...ga]);
});

test('the image data is a zlib stream that inflate reads, with one filter byte per row', async () => {
  const width = 5, height = 6;
  const data = Uint8Array.from({ length: width * height * 3 }, (_, i) => (i * 11) & 255);
  const bytes = new Uint8Array(await (await encodePngSamples({ width, height, channels: 3, data })).arrayBuffer());
  // IHDR is the first chunk; IDAT the next one here (no sRGB without srgb: true).
  const idatLen = new DataView(bytes.buffer).getUint32(33);
  assert.equal(String.fromCharCode(...bytes.subarray(37, 41)), 'IDAT');
  const raw = inflateSync(Buffer.from(bytes.subarray(41, 41 + idatLen)));
  assert.equal(raw.length, height * (width * 3 + 1));
  for (let y = 0; y < height; y++) assert.ok(raw[y * (width * 3 + 1)] <= 4, 'a valid filter type');
});

test('wrong sizes are refused', async () => {
  await assert.rejects(encodePngSamples({ width: 2, height: 2, channels: 4, data: new Uint8Array(15) }), RangeError);
  await assert.rejects(encodePngSamples({ width: 0, height: 2, channels: 4, data: new Uint8Array(0) }), RangeError);
  await assert.rejects(encodePngSamples({ width: 1, height: 1, channels: 5, data: new Uint8Array(5) }), RangeError);
});
