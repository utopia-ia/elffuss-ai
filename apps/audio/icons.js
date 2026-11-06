// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The few icons of the audio site, drawn as SVG through the DOM (never from HTML
// text), one stroke weight, coloured by the text colour of their button.

const NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  play: [['path', { d: 'M7 4.5v15l12-7.5z', fill: 'currentColor', stroke: 'none' }]],
  pause: [['rect', { x: 6, y: 4.5, width: 4, height: 15, rx: 1, fill: 'currentColor', stroke: 'none' }], ['rect', { x: 14, y: 4.5, width: 4, height: 15, rx: 1, fill: 'currentColor', stroke: 'none' }]],
  dice: [['rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4 }], ['circle', { cx: 8.5, cy: 8.5, r: 1.3, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 15.5, cy: 15.5, r: 1.3, fill: 'currentColor', stroke: 'none' }], ['circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }]],
};

/** An SVG icon by name, hidden from assistive technology (its button carries the label). */
export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of PATHS[name] || []) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    svg.append(n);
  }
  return svg;
}
