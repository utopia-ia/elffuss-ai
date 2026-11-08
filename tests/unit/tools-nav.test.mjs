// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// How the tools are found: every tool site is in a group and has an icon and a short
// name in both languages; the bar under each app's header lists them all, by group,
// with the page's own marked, and the catalog's cards follow the same groups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GROUPS, ICONS, groupSites, toolIcon } from '../../scripts/lib/tools-nav.mjs';
import { toolbar, catalogCards } from '../../scripts/lib/pages.mjs';
import { sites as readSites } from '../../deploy/sites.mjs';
import { mergeStrings } from '../../scripts/build.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sites = readSites(ROOT);
for (const s of sites) s.strings = mergeStrings(ROOT, s.dir);
const tools = sites.filter(s => !s.catalog);
const registry = JSON.parse(readFileSync(new URL('../../registry/tasks.json', import.meta.url), 'utf8'));

test('every tool site is in one group, with an icon and a short name in both languages', () => {
  const placed = GROUPS.flatMap(g => g.sites);
  assert.equal(new Set(placed).size, placed.length, 'a site in two groups');
  for (const s of tools) {
    assert.ok(placed.includes(s.site), `${s.site}: in a group`);
    assert.ok(ICONS[s.site], `${s.site}: an icon`);
    for (const lang of ['es', 'en']) assert.ok(s.strings[lang]['tool.short'], `${s.site} ${lang}: tool.short`);
  }
  assert.deepEqual(groupSites(sites).flatMap(g => g.sites.map(s => s.site)).sort(), tools.map(s => s.site).sort());
  assert.match(toolIcon('image'), /^<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
});

test('the tool bar lists every tool by group, links each to its host and marks the page it is on', () => {
  const site = tools.find(s => s.site === 'video');
  for (const lang of ['es', 'en']) {
    const html = toolbar({ site, sites, t: site.strings[lang], lang, channel: 'pro', home: lang === 'es' ? '/' : '/en/' });
    assert.match(html, /^<nav class="toolbar" aria-label="[^"]+">/);
    assert.equal((html.match(/<ul data-group=/g) || []).length, GROUPS.length);
    assert.equal((html.match(/<li>/g) || []).length, tools.length);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, new RegExp(`<a href="${lang === 'es' ? '/' : '/en/'}" data-tool="video" aria-current="page">`));
    assert.match(html, new RegExp(`<a href="https://image\\.elffuss\\.com/${lang === 'en' ? 'en/' : ''}" data-tool="image">`));
  }
  const catalog = sites.find(s => s.catalog);
  assert.equal(toolbar({ site: catalog, sites, t: catalog.strings.es, lang: 'es', channel: 'pro', home: '/' }), '', 'the catalog has none');
});

test('the catalog cards follow the groups', () => {
  const catalog = sites.find(s => s.catalog);
  const cards = catalogCards({ sites, registry, t: catalog.strings.es, lang: 'es', channel: 'pro' });
  for (const g of GROUPS) {
    const shown = [...(cards[g.id] || '').matchAll(/data-site="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(shown, g.sites.filter(n => tools.some(s => s.site === n)), g.id);
  }
});
