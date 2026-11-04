// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// "Install <site> as an app", the same behaviour as the other Elffuss apps.
//
// - The entry: the `[data-action="install"]` link in the header's nav (the build
//   writes it hidden, with the site's name in `data-app`). It shows whenever the
//   page is not running installed and not inside another page's frame, also
//   after "Not now". With the browser's own dialog (`beforeinstallprompt`,
//   Chrome and Edge) it opens that; otherwise it shows a box with the steps:
//   iPhone/iPad, Share → "Add to Home Screen"; desktop Safari, File → "Add to
//   Dock"; anything else, the browser menu.
// - The box by itself: only on a phone, once per tab; "Not now" silences it
//   until the tab is closed, never the entry.
// - Installed is any display mode other than the browser tab (only `standalone`
//   missed real app windows). Once installed, storage is asked to persist, so
//   the browser keeps the models.
//
// No inline styles and no HTML strings (the policy refuses both): elements,
// text and classes, styled by layout.css and elffuss-look.css.

const installed = () => !matchMedia('(display-mode: browser)').matches || navigator.standalone === true;
const framed = () => { try { return window.top !== window; } catch { return true; } };
const phone = () => navigator.userAgentData?.mobile === true
  || (matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches);
const iOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const macSafari = () => !iOS() && /Macintosh/.test(navigator.userAgent) && /Version\/\d+.*Safari/.test(navigator.userAgent)
  && !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent);
const SKIP = 'elffuss.install.no';
const persist = () => { navigator.storage?.persist?.().catch(() => {}); };

let box = null;
let deferred = null;   // Chrome's event, kept so the entry can open its dialog
let done = false;      // `appinstalled` came on this page
let words = null;      // the install.* strings of the page's language
let app = '';

async function loadWords() {
  if (words) return words;
  const lang = document.documentElement.lang === 'en' ? 'en' : 'es';
  try {
    const all = await (await fetch(new URL(`../strings.${lang}.json`, import.meta.url), { credentials: 'same-origin' })).json();
    words = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('install.')).map(([k, v]) => [k, String(v).replace('{app}', app)]));
  } catch {
    words = null;
  }
  return words;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function show() {
  const w = await loadWords();
  if (box || !w || !document.body) return;
  box = el('aside', 'install');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', w['install.title']);
  box.dataset.role = 'install';
  const row = el('div', 'actions');
  if (deferred) {
    const ok = el('button', 'ghost', w['install.button']);
    ok.type = 'button';
    ok.addEventListener('click', () => { openDialog(); });
    row.append(ok);
  } else {
    row.append(el('p', 'install-how', iOS() ? w['install.ios'] : macSafari() ? w['install.mac'] : w['install.other']));
  }
  const no = el('button', 'ghost', w['install.later']);
  no.type = 'button';
  no.addEventListener('click', () => { try { sessionStorage.setItem(SKIP, '1'); } catch { /* private mode */ } hide(); });
  row.append(no);
  box.append(el('p', 'install-title', w['install.title']), el('p', 'install-why muted', w['install.why']), row);
  const main = document.querySelector('main');
  if (main) main.prepend(box); else document.body.append(box);
}
function hide() { box?.remove(); box = null; }

async function openDialog() {
  const e = deferred; deferred = null; hide();
  try { await e.prompt(); } catch { /* the browser declined to show it */ }
}

/** What the entry does: the browser's dialog, or the box with the steps. */
export async function install() {
  if (done || installed() || framed()) return;
  if (deferred) { openDialog(); return; }
  hide();
  await show();
  box?.querySelector('button')?.focus({ preventScroll: true });
}

/** Start: persist storage if installed; otherwise the entry and, on a phone, the box by itself. */
export function offerInstall() {
  if (framed()) return;
  if (installed()) { persist(); return; }
  const entries = [...document.querySelectorAll('[data-action="install"]')];
  app = entries[0]?.dataset.app || document.title;
  for (const a of entries) {
    a.hidden = false;
    a.addEventListener('click', e => { e.preventDefault(); install(); });
  }
  let skipped = false;
  try { skipped = sessionStorage.getItem(SKIP) === '1'; } catch { /* private mode */ }
  const auto = phone() && !skipped;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; if (auto) { hide(); show(); } });
  addEventListener('appinstalled', () => {
    done = true; hide();
    for (const a of entries) a.hidden = true;
    persist();
  });
  if (!auto) return;
  // iOS never sends the event: the box comes at once. Elsewhere it waits for
  // Chrome's event and, if none comes (another browser), shows the steps.
  if (iOS()) show();
  else setTimeout(() => { if (!deferred) show(); }, 2500);
}
