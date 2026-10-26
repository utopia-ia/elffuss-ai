// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The size of an image from its header, read before anything decodes it, and
// the pixel budget that refuses a huge picture (too-large) up front. The headers
// are built here byte by byte, in the layout of each format.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { imageSize, checkPixelBudget, MAX_INPUT_PIXELS } from '../../sdk/core/image-input.js';

const be32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = n => [n & 255, (n >>> 8) & 255];
const le24 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = s => [...s].map(c => c.charCodeAt(0));

const png = (w, h) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const gif = (w, h) => new Uint8Array([...ascii('GIF89a'), ...le16(w), ...le16(h), 0, 0, 0]);
const bmp = (w, h) => new Uint8Array([...ascii('BM'), ...le32(0), 0, 0, 0, 0, ...le32(54), ...le32(40), ...le32(w), ...le32(h), 1, 0, 24, 0]);
const webpX = (w, h) => new Uint8Array([...ascii('RIFF'), ...le32(30), ...ascii('WEBP'), ...ascii('VP8X'), ...le32(10), 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1), 0, 0]);
const webpLossy = (w, h) => new Uint8Array([...ascii('RIFF'), ...le32(30), ...ascii('WEBP'), ...ascii('VP8 '), ...le32(10), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h), 0, 0]);
const webpLossless = (w, h) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return new Uint8Array([...ascii('RIFF'), ...le32(30), ...ascii('WEBP'), ...ascii('VP8L'), ...le32(10), 0x2f, ...le32(bits), 0, 0, 0, 0, 0]);
};
/** A JPEG with an APP0, a large APP1 (an EXIF block with a thumbnail) and then the frame header. */
const jpeg = (w, h, app1 = 60000) => new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, 0, 16, ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xe1, (app1 + 2) >> 8, (app1 + 2) & 255, ...new Array(app1).fill(0x20),
  0xff, 0xdb, 0, 3, 0,
  0xff, 0xc2, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  0xff, 0xda, 0, 2,
]);
const avif = (w, h) => new Uint8Array([0, 0, 0, 0x1c, ...ascii('ftypavif'), 0, 0, 0, 0, ...ascii('avifmif1miaf'), 0, 0, 0, 20, ...ascii('ispe'), 0, 0, 0, 0, ...be32(160), ...be32(120), 0, 0, 0, 20, ...ascii('ispe'), 0, 0, 0, 0, ...be32(w), ...be32(h)]);

test('the size comes from the header of each format the sites decode', () => {
  assert.deepEqual(imageSize(png(20000, 20000)), { width: 20000, height: 20000 });
  assert.deepEqual(imageSize(gif(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(imageSize(bmp(300, -200)), { width: 300, height: 200 }, 'a top-down bitmap has a negative height');
  assert.deepEqual(imageSize(webpX(9000, 6000)), { width: 9000, height: 6000 });
  assert.deepEqual(imageSize(webpLossy(1600, 900)), { width: 1600, height: 900 });
  assert.deepEqual(imageSize(webpLossless(321, 123)), { width: 321, height: 123 });
  assert.deepEqual(imageSize(jpeg(12000, 9000)), { width: 12000, height: 9000 }, 'found behind a large EXIF block');
  assert.deepEqual(imageSize(avif(8000, 6000)), { width: 8000, height: 6000 }, 'the largest extent, not the thumbnail');
});

test('a header that is cut or unknown gives no size', () => {
  assert.equal(imageSize(png(10, 10).subarray(0, 20)), null);
  assert.equal(imageSize(jpeg(100, 100).subarray(0, 4000)), null);
  assert.equal(imageSize(new Uint8Array(ascii('hello, world, not an image'))), null);
  assert.equal(imageSize(png(0, 10)), null, 'no pixels is no size');
  // A PNG signature followed by anything but its header chunk: no size (left to the decoder, which fails).
  assert.equal(imageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ascii('basura que no es una imagen')])), null);
  assert.equal(imageSize(new Uint8Array([...ascii('BM'), ...new Array(12).fill(0), ...ascii('not a DIB header at all')])), null);
  // An IHDR whose fields PNG does not allow (sides over 2^31 − 1, no such bit depth): no size.
  const bad = png(1, 1);
  bad.fill(0xee, 16, 29);
  assert.equal(imageSize(bad), null, 'the broken PNG of the OCR folder fixture is left to the decoder');
});

test('the pixel budget refuses a huge picture before decoding, whatever the file weighs', async () => {
  // A whole PNG of 20000 × 20000 in one colour: a few hundred kilobytes on disk.
  const row = new Uint8Array(1 + 20000 * 4);
  const idat = deflateSync(Buffer.alloc(row.length * 64));
  const file = new Blob([png(20000, 20000), idat]);
  await assert.rejects(checkPixelBudget(file), e => e.code === 'too-large' && e.details.width === 20000);
  await assert.rejects(checkPixelBudget(new Blob([jpeg(12000, 9000)])), { code: 'too-large' });
  assert.deepEqual(await checkPixelBudget(new Blob([jpeg(8000, 6000)])), { width: 8000, height: 6000 }, 'a 48-megapixel photo passes');
  assert.deepEqual(await checkPixelBudget(new Blob([png(8192, 8192)])), { width: 8192, height: 8192 }, 'the budget itself passes');
  assert.equal(MAX_INPUT_PIXELS, 8192 * 8192);
  assert.equal(await checkPixelBudget(new Blob([new Uint8Array(ascii('GIF89a'))])), null, 'a header that does not say is left to the decoder');
});
