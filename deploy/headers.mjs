// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The single source of the sites' HTTP headers and Content Security Policy.
// deploy/build-nginx.mjs writes the nginx snippets from it, the test harness
// serves the same headers, and test builds also carry the policy in a <meta>.
// Only the model store's origin changes between production and the tests.

/** The model store, embedded as a hidden iframe. */
export const STORE_ORIGIN = 'https://models.elffuss.com';

/**
 * The only page that may show a site in a frame: the chat on elffuss.com opens
 * the tools whose app.json says `embed: true` inside its own window (its
 * chat/appview.js), so an installed Elffuss does not leave for a browser tab.
 * Every other site, and every other embedder, stays refused.
 */
export const EMBEDDERS = Object.freeze(['https://elffuss.com']);

/**
 * Content Security Policy of a site.
 * - apps: scripts from the site only, plus WebAssembly compilation; Workers from
 *   the site; the store as the only frame; nothing inline; Trusted Types required.
 *   A site that plays what it makes (`media: true`, the video site) may play blob:
 *   URLs of its own page, and nothing else.
 * - catalog: no WebAssembly and no Workers.
 * - both: the web app manifest from the site (so it can be installed as an app).
 * - frames: no one may frame a site, except EMBEDDERS a site with `embed: true`.
 * Never 'unsafe-eval' and never 'unsafe-inline'.
 * @param {{ catalog?: boolean, media?: boolean }} site
 * @param {{ storeOrigin?: string, meta?: boolean }} [opts] `meta` drops the directives a <meta> cannot carry
 */
export function csp(site, { storeOrigin = STORE_ORIGIN, meta = false } = {}) {
  const d = site.catalog
    ? [
        ["default-src", "'self'"], ['script-src', "'self'"], ['style-src', "'self'"], ['img-src', "'self'"],
        ['font-src', "'none'"], ['media-src', "'none'"], ['connect-src', "'self'"], ['worker-src', "'none'"],
        ['frame-src', storeOrigin], ['object-src', "'none'"], ['base-uri', "'none'"], ['form-action', "'none'"],
        ['frame-ancestors', "'none'"], ['manifest-src', "'self'"], ['require-trusted-types-for', "'script'"], ['trusted-types', "'none'"],
      ]
    : [
        ['default-src', "'self'"], ['script-src', "'self' 'wasm-unsafe-eval'"], ['style-src', "'self'"], ['img-src', "'self' blob:"],
        ['font-src', "'none'"], ['media-src', site.media ? 'blob:' : "'none'"], ['connect-src', "'self'"], ['worker-src', "'self'"],
        ['frame-src', storeOrigin], ['object-src', "'none'"], ['base-uri', "'none'"], ['form-action', "'none'"],
        ['frame-ancestors', site.embed ? EMBEDDERS.join(' ') : "'none'"], ['manifest-src', "'self'"], ['require-trusted-types-for', "'script'"], ['trusted-types', 'elffuss-ai'],
      ];
  return d.filter(([k]) => !(meta && k === 'frame-ancestors')).map(([k, v]) => `${k} ${v}`).join('; ');
}

/** Permissions-Policy of a site: everything off, the camera only where a site uses it. */
export function permissionsPolicy(site) {
  const camera = site.camera ? 'camera=(self)' : 'camera=()';
  return [camera, 'microphone=()', 'geolocation=()', 'usb=()', 'serial=()', 'hid=()', 'bluetooth=()', 'payment=()', 'display-capture=()', 'browsing-topics=()'].join(', ');
}

/** Headers every response of every site carries. */
export function commonHeaders() {
  return [
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'no-referrer'],
    ['Strict-Transport-Security', 'max-age=31536000'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
  ];
}

/**
 * X-Frame-Options of a site: DENY, except on a site that EMBEDDERS may frame.
 * There the CSP's frame-ancestors says who may (X-Frame-Options cannot name
 * another origin, and a browser that knows frame-ancestors ignores it anyway).
 */
export function frameHeaders(site) {
  return site.embed ? [] : [['X-Frame-Options', 'DENY']];
}

/** Cache-Control by kind of path. */
export const CACHE = Object.freeze({
  html: 'no-cache',
  v: 'public, max-age=31536000, immutable',
  vendor: 'public, max-age=31536000, immutable',
  beta: 'no-cache',
});

/**
 * Every header of a response of a site.
 * @param {object} site
 * @param {{ storeOrigin?: string, kind?: keyof typeof CACHE }} [opts]
 * @returns {[string, string][]}
 */
export function headersFor(site, { storeOrigin = STORE_ORIGIN, kind = 'html' } = {}) {
  const h = [...commonHeaders(), ...frameHeaders(site), ['Content-Security-Policy', csp(site, { storeOrigin })], ['Permissions-Policy', permissionsPolicy(site)], ['Cache-Control', CACHE[kind]]];
  if (kind === 'beta') h.push(['X-Robots-Tag', 'noindex']);
  return h;
}

/** MIME types the sites serve, by extension (the server's own list is incomplete). */
export const TYPES = Object.freeze({
  html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  wasm: 'application/wasm', svg: 'image/svg+xml', png: 'image/png', txt: 'text/plain; charset=utf-8',
  bcmap: 'application/octet-stream', pfb: 'application/octet-stream', ttf: 'font/ttf', icc: 'application/vnd.iccprofile',
});
