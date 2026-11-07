// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A local server for the text-to-video test page (tests/browser/pages/video-gen.html):
// the repository under /v/dev/, the pinned runtimes under /vendor/, and the model
// files from the weight cache under /hf/<repo>/<revision>/<path> (the layout of
// scripts/fetch-weights.mjs). The page stands in for the model store with these
// URLs, so it runs before the converted files are hosted anywhere.
//
//   ELFFUSS_AI_CACHE=<cache> node tests/browser/video-gen-serve.mjs [port]
//   then open http://127.0.0.1:<port>/v/dev/tests/browser/pages/video-gen.html
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = process.env.ELFFUSS_AI_CACHE;
if (!CACHE) { console.error('set ELFFUSS_AI_CACHE to the weight cache'); process.exit(2); }
const ROOTS = { '/v/dev/': REPO, '/vendor/': join(REPO, 'vendor'), '/hf/': join(CACHE, 'hf') };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const port = Number(process.argv[2] || 8932);

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const prefix = Object.keys(ROOTS).find(p => url.pathname.startsWith(p));
  if (!prefix) { res.writeHead(404).end(); return; }
  const rel = normalize(decodeURIComponent(url.pathname.slice(prefix.length)));
  if (rel.startsWith('..')) { res.writeHead(403).end(); return; }
  const file = join(ROOTS[prefix], rel);
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'content-length': String(statSync(file).size), 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/v/dev/tests/browser/pages/video-gen.html`));
