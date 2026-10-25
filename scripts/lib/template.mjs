// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The page templates. Three kinds of placeholder, all strict (an unknown key is
// an error, never an empty string):
//   {{t:key}}     a text of strings.<lang>.json, HTML-escaped
//   {{v:name}}    a value computed by the build, HTML-escaped
//   {{html:name}} a fragment the build generated (already escaped inside)

/** Escape text for HTML content and attribute values. */
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Fill {name} placeholders of a text. */
export function fill(s, vars = {}) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`text "${s}" needs {${k}}`);
    return String(vars[k]);
  });
}

/**
 * @param {string} tpl
 * @param {{ t?: Record<string,string>, v?: Record<string,string|number>, html?: Record<string,string> }} data
 */
export function render(tpl, { t = {}, v = {}, html = {} }) {
  return tpl.replace(/\{\{(t|v|html):([\w.-]+)\}\}/g, (m, kind, key) => {
    const src = kind === 't' ? t : kind === 'v' ? v : html;
    if (!(key in src)) throw new Error(`template needs ${kind}:${key}`);
    return kind === 'html' ? src[key] : esc(src[key]);
  });
}
