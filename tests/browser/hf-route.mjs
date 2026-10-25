// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Hugging Face, for the browser tests. Every request the browser makes to the
// Hub goes through a Playwright route that vets and counts it: a pinned file of
// the registry is continued to a local HTTPS server that streams it from the
// weight cache (with Range, ETag and the CORS headers the model store needs);
// anything else gets 404 and is recorded, and the test fails on it. The URLs
// the browser sees are the production ones, so the store's keys are too.
// Whole files, one-byte probes and ranged requests are counted apart: a probe is
// not a download.
//
// (Fulfilling a large body from the route itself would pass the whole file
// through the test driver as one message; continuing to a local server streams it.)
import { createServer } from 'node:https';
import { Transform } from 'node:stream';
import { existsSync, statSync, createReadStream, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { registryUrls } from '../../sdk/core/registry.js';
import { parsePinnedUrl, HUB_ORIGIN } from '../../sdk/core/hub-url.js';
import { cachePath } from '../../scripts/fetch-weights.mjs';

/** A throwaway certificate for the local Hub server (the test contexts ignore HTTPS errors). */
export function testCertificate(dir) {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert,
      '-days', '7', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * Start the local Hub server and return the route to install in each context.
 * @param {{ cache: string, registry: object, port: number }} o
 */
export async function startHub({ cache, registry, port }) {
  const allowed = new Map(registryUrls(registry).map(u => [new URL(u.url).pathname, u]));
  const counts = { full: [], probes: [], ranged: [], refused: [] };
  const served = new Map(); // url → bytes actually written to the browser
  let blocked = false;
  let corrupted = null; // pinned URL whose middle byte is flipped (same size)
  // Count what reaches the browser, and flip one byte of the corrupted file.
  const sink = (entry, start) => {
    let pos = start;
    const mid = Math.floor(entry.size / 2);
    return new Transform({
      transform(chunk, _enc, done) {
        if (corrupted === entry.url && mid >= pos && mid < pos + chunk.length) { chunk = Buffer.from(chunk); chunk[mid - pos] ^= 0xff; }
        pos += chunk.length;
        served.set(entry.url, (served.get(entry.url) || 0) + chunk.length);
        done(null, chunk);
      },
    });
  };
  const tls = testCertificate(join(cache, 'tmp', 'hub-tls'));
  const server = createServer(tls, (req, res) => {
    const entry = allowed.get(new URL(req.url, 'https://127.0.0.1').pathname);
    const cors = {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-expose-headers': 'Content-Range, ETag, Content-Length, Accept-Ranges',
      vary: 'Origin',
    };
    if (!entry) { res.writeHead(404, cors).end(); return; }
    const p = parsePinnedUrl(entry.url);
    const file = cachePath(cache, p.repo, p.revision, p.path);
    if (!existsSync(file) || statSync(file).size !== entry.size) { res.writeHead(500, cors).end('not in the weight cache: run scripts/fetch-weights.mjs'); return; }
    const size = entry.size;
    const headers = { ...cors, etag: `"${p.revision.slice(0, 12)}-${size}"`, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' };
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) { res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` }).end(); return; }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file, { start, end }).pipe(sink(entry, start)).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(sink(entry, 0)).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', err => reject(err.code === 'EADDRINUSE' ? new Error(`port ${port} is in use`) : err));
    server.listen(port, '127.0.0.1', resolve);
  });

  async function handler(route, request) {
    const url = request.url();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': request.headers().origin || '*', 'access-control-allow-headers': 'Range', 'access-control-allow-methods': 'GET, HEAD' } });
    }
    if (blocked) return route.abort('connectionrefused');
    const u = new URL(url);
    if (u.search || u.hash || !allowed.has(u.pathname) || allowed.get(u.pathname).url !== url) {
      counts.refused.push(url);
      return route.fulfill({ status: 404, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': request.headers().origin || '*' }, body: 'not a pinned file of the registry' });
    }
    const range = request.headers().range;
    if (!range) counts.full.push(url);
    else if (range === 'bytes=0-0') counts.probes.push(url);
    else counts.ranged.push(url);
    return route.continue({ url: `https://127.0.0.1:${port}${u.pathname}` });
  }

  return {
    pattern: `${HUB_ORIGIN}/**`,
    handler,
    counts,
    served,
    reset() { for (const k of Object.keys(counts)) counts[k].length = 0; served.clear(); },
    /** Serve this pinned URL with one byte changed (same size), or stop with null. */
    corrupt(url) { corrupted = url; },
    /** Make the Hub unreachable, or reachable again. */
    block(on) { blocked = on; },
    server,
  };
}

/** True when the weight cache has every URL with its size (fetch-weights.mjs verified the hashes). */
export function cacheHas(cache, urls) {
  return urls.every(({ url, size }) => {
    const p = parsePinnedUrl(url);
    const f = cachePath(cache, p.repo, p.revision, p.path);
    return existsSync(f) && statSync(f).size === size;
  });
}
