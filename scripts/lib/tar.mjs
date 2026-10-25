// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A small reader for the .tgz files of the npm registry (ustar, with pax and GNU
// long names). Read-only: it returns the regular files it finds, and never
// writes anything or follows links.
import { gunzipSync } from 'node:zlib';

const field = (buf, off, len) => {
  const s = buf.subarray(off, off + len);
  const end = s.indexOf(0);
  return (end < 0 ? s : s.subarray(0, end)).toString('utf8');
};
const octal = (buf, off, len) => {
  const s = field(buf, off, len).trim();
  return s ? parseInt(s, 8) : 0;
};

/**
 * List the regular files of a gzipped tarball.
 * @param {Buffer} tgz
 * @returns {Map<string, Buffer>} path inside the archive → bytes
 */
export function readTgz(tgz) {
  const tar = gunzipSync(tgz);
  const files = new Map();
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = field(h, 345, 155);
    let name = field(h, 0, 100);
    if (prefix) name = prefix + '/' + name;
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') {
      for (const rec of body.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath || longName || name;
    paxPath = null; longName = null;
    if (type !== '0' && type !== '\0' && type !== '7') continue; // only regular files
    if (path.split('/').some(p => p === '..')) throw new Error('unsafe path in tarball: ' + path);
    files.set(path, Buffer.from(body));
  }
  return files;
}
