// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The form controls every tool site shares, built on the page's own controls so
// that a site's script keeps reading and setting them as before:
//
// - a `select[data-segmented]` gets a segmented control next to it (one button per
//   visible option, role radio, arrow keys move the choice); the select stays the
//   source of truth, out of sight: what a script sets on it (value, options,
//   disabled, an option hidden) shows on the buttons, and a press sets it and fires
//   its `input` and `change` events;
// - an `output[data-range]` shows the value of the range input it is `for`, with its
//   `data-suffix`, in the page's number format.
//
// No HTML strings, no styles: buttons are `button.ghost`, their look is the shared
// sheet's.

const VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');

/** A segmented control for one select. */
function segmented(select) {
  const group = document.createElement('div');
  group.className = 'segmented';
  group.setAttribute('role', 'radiogroup');
  for (const a of ['aria-labelledby', 'aria-label', 'aria-describedby']) if (select.hasAttribute(a)) group.setAttribute(a, select.getAttribute(a));
  if (select.dataset.segmented === 'wrap') group.dataset.wrap = 'true';
  select.after(group);
  select.classList.add('visually-hidden');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const choose = (value, focus) => {
    if (select.disabled || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    if (focus) group.querySelector('[aria-checked="true"]')?.focus();
  };
  const buttons = () => [...group.querySelectorAll('button')];
  const render = () => {
    const opts = [...select.options].filter(o => !o.hidden);
    const have = buttons();
    if (have.length !== opts.length || have.some((b, i) => b.dataset.value !== opts[i].value || b.textContent !== opts[i].textContent)) {
      group.replaceChildren(...opts.map(o => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ghost';
        b.setAttribute('role', 'radio');
        b.dataset.value = o.value;
        b.textContent = o.textContent;
        b.addEventListener('click', () => choose(o.value, false));
        return b;
      }));
    }
    for (const b of buttons()) {
      const on = b.dataset.value === select.value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.disabled = select.disabled;
    }
    if (!buttons().some(b => b.tabIndex === 0) && buttons()[0]) buttons()[0].tabIndex = 0;
  };
  group.addEventListener('keydown', e => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys) && e.key !== 'Home' && e.key !== 'End') return;
    const list = buttons();
    if (!list.length) return;
    e.preventDefault();
    const i = list.findIndex(b => b.dataset.value === select.value);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (Math.max(0, i) + keys[e.key] + list.length) % list.length;
    choose(list[next].dataset.value, true);
  });
  // What the site's script does to the select shows at once.
  Object.defineProperty(select, 'value', { configurable: true, get() { return VALUE.get.call(this); }, set(v) { VALUE.set.call(this, v); render(); } });
  select.addEventListener('change', render);
  select.addEventListener('input', render);
  new MutationObserver(render).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected', 'label'] });
  render();
}

/** The live value of a range input in its output. */
function rangeOutput(out, lang) {
  const input = document.getElementById(out.htmlFor.value || '');
  if (!input) return;
  const show = () => {
    const n = Number(input.value);
    const text = Number.isFinite(n) ? n.toLocaleString(lang === 'en' ? 'en' : 'es', { maximumFractionDigits: 2 }) : input.value;
    out.textContent = text + (out.dataset.suffix || '');
  };
  input.addEventListener('input', show);
  input.addEventListener('change', show);
  show();
}

/** Build the shared controls of a page (once). */
export function enhanceControls(root = document, lang = document.documentElement.lang) {
  for (const s of root.querySelectorAll('select[data-segmented]')) if (!s.nextElementSibling?.matches('.segmented')) segmented(s);
  for (const o of root.querySelectorAll('output[data-range]')) rangeOutput(o, lang);
}

/**
 * Show a control that may be folded away (in a closed «Advanced settings»): open
 * every closed details around it. Call it before focusing or filling it for the person.
 * @param {Element|null} el
 */
export function reveal(el) {
  for (let d = el?.closest('details:not([open])'); d; d = d.parentElement?.closest('details:not([open])')) d.open = true;
}
