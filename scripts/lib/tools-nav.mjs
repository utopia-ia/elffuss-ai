// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// How the tools are found: their groups (what you make, and what you do with a
// photo or a document), their order and their icons. The tool bar under every
// app's header and the catalog are built from here, so a new site needs one line
// in GROUPS and one icon. Icons are drawn on a 24 × 24 grid with a 1.75 stroke,
// round caps and joins; their colour is the text's (currentColor).

/** The groups, in order, each with its sites in order. A site in no group goes last in the last. */
export const GROUPS = [
  { id: 'create', sites: ['image', 'video', 'audio'] },
  { id: 'photo', sites: ['cutout', 'ocr', 'detect', 'depth'] },
];

/** The inner SVG of each tool's icon. */
export const ICONS = {
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.75"/><path d="M 21 15.5l -4.5-4.5L 7 20.5"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M 10.25 9.25v 5.5l 4.75-2.75z"/>',
  audio: '<path d="M 4 10v 4M 8 7v 10M 12 4v 16M 16 8v 8M 20 10.5v 3"/>',
  cutout: '<path d="M 3.5 7.5v -2a 2 2 0 0 1 2-2h 2M 16.5 3.5h 2a 2 2 0 0 1 2 2v 2M 20.5 16.5v 2a 2 2 0 0 1-2 2h -2M 7.5 20.5h -2a 2 2 0 0 1-2-2v -2"/><circle cx="12" cy="9.5" r="2.75"/><path d="M 7.25 17.25c .9-2.3 2.6-3.5 4.75-3.5s 3.85 1.2 4.75 3.5"/>',
  ocr: '<path d="M 6 3h 8.5L 19 7.5V 21H 6z"/><path d="M 14 3v 5h 5M 9 12h 7M 9 15.5h 7M 9 19h 4"/>',
  detect: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M 3 7V 4.5A 1.5 1.5 0 0 1 4.5 3H 7M 17 3h 2.5A 1.5 1.5 0 0 1 21 4.5V 7M 21 17v 2.5a 1.5 1.5 0 0 1-1.5 1.5H 17M 7 21H 4.5A 1.5 1.5 0 0 1 3 19.5V 17"/>',
  depth: '<path d="M 12 3.5l 8.5 4.75L 12 13 3.5 8.25z"/><path d="M 3.5 12.25L 12 17l 8.5-4.75M 3.5 16.25L 12 21l 8.5-4.75"/>',
};

/** The icon of a drop zone (something going up into the page). */
export const UPLOAD_ICON = '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M 12 15.5V 4M 7.5 8.5 12 4l 4.5 4.5"/><path d="M 4 14.5v 3A 2.5 2.5 0 0 0 6.5 20h 11a 2.5 2.5 0 0 0 2.5-2.5v -3"/></svg>';

/** An icon as markup (decorative: the name next to it says what it is). */
export function toolIcon(site, cls = 'tool-icon') {
  const inner = ICONS[site] || ICONS.image;
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/** The tool sites grouped and ordered: [{ id, sites: [site objects] }]. */
export function groupSites(sites) {
  const tools = sites.filter(s => !s.catalog);
  const placed = new Set(GROUPS.flatMap(g => g.sites));
  const groups = GROUPS.map(g => ({ id: g.id, sites: g.sites.map(n => tools.find(s => s.site === n)).filter(Boolean) }));
  const rest = tools.filter(s => !placed.has(s.site));
  if (rest.length) groups[groups.length - 1].sites.push(...rest);
  return groups.filter(g => g.sites.length);
}
