// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Local origins for the browser tests: one HTTP server per site, on the site's
// test port, serving its test build with the headers of deploy/headers.mjs (the
// same CSP as production, with the store at http://localhost:8789), and one
// server for the model store page. localhost is one site on every port and a
// different origin on each, like the subdomains of elffuss.com.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { headersFor, TYPES } from '../../deploy/headers.mjs';

/** Kind of a path for its headers. */
export function kindOf(path) {
  if (path.startsWith('/v/')) return 'v';
  if (path.startsWith('/vendor/')) return 'vendor';
  if (path.startsWith('/beta/')) return 'beta';
  return 'html';
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', err => reject(err.code === 'EADDRINUSE' ? new Error(`port ${port} is in use; free it or set another port`) : err));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Serve one site's build.
 * @param {{ site: object, root: string, port: number, storeOrigin: string, log?: (r: object) => void }} o
 */
export async function startSiteServer({ site, root, port, storeOrigin, log }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    const parts = path.split('/');
    const bad = req.method !== 'GET' && req.method !== 'HEAD' || parts.some(p => p === '..' || p.startsWith('._') || (p.startsWith('.') && p.length > 1));
    let file = bad ? null : normalize(join(root, path));
    if (file && !file.startsWith(root + sep) && file !== root) file = null;
    if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    const ok = file && existsSync(file) && statSync(file).isFile();
    const served = ok ? file : join(root, '404.html');
    const kind = kindOf(path);
    const headers = Object.fromEntries(headersFor(site, { storeOrigin, kind }));
    headers['Content-Type'] = TYPES[extname(served).slice(1)] || 'application/octet-stream';
    log?.({ site: site.site, path, status: ok ? 200 : 404 });
    if (!existsSync(served)) { res.writeHead(404, headers).end(); return; }
    headers['Content-Length'] = String(statSync(served).size);
    res.writeHead(ok ? 200 : 404, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(served).pipe(res);
  });
  return listen(server, port);
}

/**
 * Serve the model store page at / (and refuse its service worker: the tests block them anyway).
 * @param {{ file: string, port: number, log?: (r: object) => void }} o
 */
export async function startStoreServer({ file, port, log }) {
  const html = readFileSync(file);
  const server = createServer((req, res) => {
    const path = new URL(req.url, `http://localhost:${port}`).pathname;
    log?.({ site: 'store', path });
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Length': String(html.length) });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  });
  return listen(server, port);
}

/** Close servers, ignoring the ones already closed. */
export async function stopAll(servers) {
  await Promise.all(servers.map(s => new Promise(r => { try { s.closeAllConnections?.(); s.close(() => r()); } catch { r(); } })));
}
