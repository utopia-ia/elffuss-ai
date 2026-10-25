// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The ZIP writer (against Node's CRC-32 and, when installed, `unzip -t`), the
// integrity check (against Node's hashes) and image sniffing by first bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zcrc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, createZip, readZip, sanitizeZipPath, uniquePaths } from '../../sdk/core/zip.js';
import { sha256Hex, gitBlobSha1, verifyFile, createVerifiedMemo } from '../../sdk/core/integrity.js';
import { sniffImageType } from '../../sdk/core/image-input.js';

test('CRC-32 matches zlib', () => {
  for (const s of ['', 'a', 'Ñandú, pingüino y cigüeña', 'x'.repeat(10000)]) {
    const b = new TextEncoder().encode(s);
    assert.equal(crc32(b), zcrc32(b), s.slice(0, 20));
  }
});

test('names are sanitised and made unique', () => {
  assert.equal(sanitizeZipPath('/a/../b\\c<d>.txt'), 'a/b/c_d_.txt');
  assert.equal(sanitizeZipPath('más/\u0007x?.txt'), 'más/x_.txt');
  assert.equal(sanitizeZipPath('../..'), '_');
  assert.deepEqual(uniquePaths(['a.txt', 'A.txt', 'a.txt', 'dir/b']), ['a.txt', 'A (2).txt', 'a (3).txt', 'dir/b']);
});

test('a ZIP reads back: store method, UTF-8 flag, CRC, contents', () => {
  const entries = [{ name: 'texto/facturas/enero.png.txt', data: 'FACTURA Nº 2026/0147\n' }, { name: 'texto.md', data: '# Texto extraído\n' }, { name: 'texto.md', data: 'dup' }];
  const zip = createZip(entries, { date: new Date(2026, 9, 25, 16, 30) });
  const back = readZip(zip);
  assert.deepEqual(back.map(e => e.name), ['texto/facturas/enero.png.txt', 'texto.md', 'texto (2).md']);
  for (const e of back) {
    assert.equal(e.method, 0);
    assert.equal(e.flags & 0x0800, 0x0800);
    assert.equal(e.crc, zcrc32(e.data));
  }
  assert.equal(new TextDecoder().decode(back[0].data), 'FACTURA Nº 2026/0147\n');
  let unzip = null;
  try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); unzip = 'unzip'; } catch { /* not installed */ }
  if (unzip) {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    try {
      writeFileSync(join(dir, 'x.zip'), zip);
      const out = execFileSync(unzip, ['-t', join(dir, 'x.zip')], { encoding: 'utf8' });
      assert.match(out, /No errors detected/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('hashes match Node, and verifyFile checks size, content and remembers', async () => {
  const b = new TextEncoder().encode('{"a":1}');
  assert.equal(await sha256Hex(b), createHash('sha256').update(b).digest('hex'));
  assert.equal(await gitBlobSha1(b), createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex'));
  const memo = createVerifiedMemo({ indexedDB: null });
  const meta = { size: b.length, gitOid: await gitBlobSha1(b) };
  const first = await verifyFile(new Blob([b]), meta, 'u', memo);
  assert.equal(first.byteLength, b.length, 'read once to hash it');
  assert.equal(await verifyFile(new Blob([b]), meta, 'u', memo), null, 'remembered: not read again');
  await assert.rejects(verifyFile(new Blob([b, b]), meta, 'u', memo), { code: 'integrity' });
  const flipped = b.slice(); flipped[0] ^= 1;
  await assert.rejects(verifyFile(new Blob([flipped]), meta, 'v', memo), { code: 'integrity' }, 'same size, one byte changed');
  await assert.rejects(verifyFile(new Blob([b]), { size: b.length }, 'w', memo), { code: 'integrity' }, 'no hash in the registry');
});

test('image types by their first bytes, not by name', () => {
  const head = (...bytes) => new Uint8Array([...bytes, ...new Array(32).fill(0)]);
  const ascii = s => [...s].map(c => c.charCodeAt(0));
  assert.equal(sniffImageType(head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffImageType(head(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImageType(head(...ascii('GIF89a'))), 'image/gif');
  assert.equal(sniffImageType(head(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'))), 'image/webp');
  assert.equal(sniffImageType(head(...ascii('BM'))), 'image/bmp');
  assert.equal(sniffImageType(head(0, 0, 0, 0x1c, ...ascii('ftypavif'))), 'image/avif');
  assert.equal(sniffImageType(head(0, 0, 0, 0x18, ...ascii('ftypheic'))), 'image/heic');
  assert.equal(sniffImageType(head(0x49, 0x49, 0x2a, 0x00)), 'image/tiff');
  assert.equal(sniffImageType(head(...ascii('%PDF-1.7'))), 'application/pdf');
  assert.equal(sniffImageType(head(...ascii('hello'))), null);
});
