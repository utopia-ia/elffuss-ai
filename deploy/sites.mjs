// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The list of sites, read from apps/*/app.json and catalog/app.json. The build,
// the headers, the nginx files, the broker lines and the test harness all start
// from here, so a site exists in one place.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{ site: string, host: string, testPort: number, dir: string, catalog?: boolean, task?: string,
 *   models?: string[], camera?: boolean, pdfjs?: boolean, accept?: string, status?: 'scaffold'|'ready',
 *   adapted?: { key: string, file: string, license: string }[] }} Site
 *   `adapted`: code of other projects the site's modules adapt: the strings key that says what, the
 *   licence file under LICENSES/ and its name, shown on the licence pages and served with the site.
 */

/** Every site: the catalog first, then the apps in alphabetical order. @returns {Site[]} */
export function sites(root = ROOT) {
  const out = [];
  const cat = join(root, 'catalog', 'app.json');
  if (existsSync(cat)) out.push({ ...JSON.parse(readFileSync(cat, 'utf8')), dir: 'catalog' });
  const appsDir = join(root, 'apps');
  for (const name of readdirSync(appsDir).sort()) {
    const p = join(appsDir, name, 'app.json');
    if (!existsSync(p)) continue;
    const s = JSON.parse(readFileSync(p, 'utf8'));
    if (s.site !== name) throw new Error(`apps/${name}/app.json: site must be "${name}"`);
    out.push({ ...s, dir: `apps/${name}` });
  }
  for (const s of out) {
    if (!/^[a-z][a-z0-9-]*$/.test(s.site)) throw new Error('bad site name ' + s.site);
    for (const a of s.adapted || []) {
      if (!/^LICENSES\/[\w.+-]+\.txt$/.test(a.file || '') || !existsSync(join(root, a.file)) || !a.key || !a.license) throw new Error(`${s.site}: bad adapted entry ${JSON.stringify(a)}`);
    }
    if (s.host !== `${s.site}.elffuss.com`) throw new Error(`${s.site}: host must be ${s.site}.elffuss.com`);
    if (!(s.testPort >= 1024 && s.testPort < 65536)) throw new Error(`${s.site}: bad testPort`);
  }
  if (new Set(out.map(s => s.testPort)).size !== out.length) throw new Error('two sites share a test port');
  return out;
}

/** One site by name. */
export function site(name, root = ROOT) {
  const s = sites(root).find(x => x.site === name);
  if (!s) throw new Error('unknown site ' + name);
  return s;
}

/** The host names of every site. */
export function siteHosts(root = ROOT) {
  return sites(root).map(s => s.host);
}

/** Base URL of a site for a channel (`test` serves each on localhost). */
export function siteUrl(s, channel) {
  if (channel === 'test') return `http://localhost:${s.testPort}/`;
  return `https://${s.host}/`;
}
