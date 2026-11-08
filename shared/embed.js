// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A tool open inside the chat on elffuss.com, in a frame (its chat/appview.js),
// instead of a browser tab: what changes for the page.
//
// - Links. A link that leaves the site would load the other page in the chat's
//   frame (the chat inside itself, or a tool under another tool's name). The
//   chat says on load which addresses it opens in place ({ type:
//   'elffuss:embed', hosts }); a click on a link to the chat (elffuss.com) or to
//   one of those hosts asks the chat to open it ({ type: 'elffuss:open', href }),
//   and any other address opens in a new tab. Links within the site stay in the
//   frame. Before the chat has said anything, every link out opens in a new tab.
// - `<html class="in-elffuss">`, for the styles of a page under the chat's bar.
//
// Only the chat may frame these sites (frame-ancestors https://elffuss.com in
// deploy/headers.mjs), and messages go to that origin only and are taken from it
// only. Outside a frame nothing here runs.

export const CHAT_ORIGIN = 'https://elffuss.com';

/** Inside another page's frame. */
export const framed = () => { try { return window.top !== window; } catch { return true; } };

/** A phone or tablet with Apple's mobile browser (the tablet reports a desktop platform with a touch screen). */
export const iOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let started = false;

/** Set up the page for the chat's frame. Does nothing outside a frame. */
export function embedInElffuss() {
  if (started || !framed()) return;
  started = true;
  document.documentElement.classList.add('in-elffuss');
  let hosts = null;   // the hosts the chat opens in place; null until it says
  addEventListener('message', e => {
    if (e.origin !== CHAT_ORIGIN || e.source !== window.parent) return;
    const d = e.data;
    if (d?.type === 'elffuss:embed' && Array.isArray(d.hosts)) hosts = new Set(d.hosts.filter(h => typeof h === 'string'));
  });
  // Capture: before a page's own handlers, and only for plain clicks (a modified
  // click is the person's own choice of tab or window).
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    let url;
    try { url = new URL(a.href, location.href); } catch { return; }
    if (url.origin === location.origin || !/^https?:$/.test(url.protocol)) return;
    e.preventDefault();
    if (hosts && (url.origin === CHAT_ORIGIN || (url.protocol === 'https:' && hosts.has(url.host)))) {
      window.parent.postMessage({ type: 'elffuss:open', href: url.href }, CHAT_ORIGIN);
      return;
    }
    window.open(url.href, '_blank', 'noopener');
  }, true);
  // Ask the chat for its list (it also sends it on its own when the frame loads).
  try { window.parent.postMessage({ type: 'elffuss:hello' }, CHAT_ORIGIN); } catch { /* not the chat */ }
}
