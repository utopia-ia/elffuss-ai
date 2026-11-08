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
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.75"/><path d="M21 15.5l-4.5-4.5L7 20.5"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.25 9.25v5.5l4.75-2.75z"/>',
  audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10.5v3"/>',
  cutout: '<path d="M3.5 7.5v-2a2 2 0 0 1 2-2h2M16.5 3.5h2a2 2 0 0 1 2 2v2M20.5 16.5v2a2 2 0 0 1-2 2h-2M7.5 20.5h-2a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="9.5" r="2.75"/><path d="M7.25 17.25c.9-2.3 2.6-3.5 4.75-3.5s3.85 1.2 4.75 3.5"/>',
  ocr: '<path d="M6 3h8.5L19 7.5V21H6z"/><path d="M14 3v5h5M9 12h7M9 15.5h7M9 19h4"/>',
  detect: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M17 3h2.5A1.5 1.5 0 0 1 21 4.5V7M21 17v2.5a1.5 1.5 0 0 1-1.5 1.5H17M7 21H4.5A1.5 1.5 0 0 1 3 19.5V17"/>',
  depth: '<path d="M12 3.5l8.5 4.75L12 13 3.5 8.25z"/><path d="M3.5 12.25L12 17l8.5-4.75M3.5 16.25L12 21l8.5-4.75"/>',
};

/** The icon of a drop zone (something going up into the page). */
export const UPLOAD_ICON = '<svg class="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 15.5V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4 14.5v3A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-3"/></svg>';

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
