// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The progress of a storyboard video, drawn as it is made (no spinner):
//   - the storyboard first: a card per keyframe (0 s, 3 s, …) with its text; while a
//     keyframe is painted, its card shows the step's estimate, soft, and the finished
//     picture fades in over it;
//   - between two cards, the clip's slot, a strip of three frames that sharpen at each
//     of the four steps; when the clip is made its strip becomes the clip itself,
//     playing in a loop (muted);
//   - a timeline under it all: a segment per clip, filled as each one is made, that
//     plays what is done.
// After the keyframes, "Continue" / "Change" with a countdown that continues on its own;
// "Change" lets the person edit a keyframe's text and paint it again.
// prefers-reduced-motion: no fades, no autoplay; pictures swap when ready.
// No style attributes: classes, <canvas>, <progress> and <video> only.

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) n.setAttribute(k, v === true ? '' : String(v));
  n.append(...kids.filter(c => c != null && c !== false));
  return n;
};

function paint(canvas, img) {
  if (!img) return;
  if (canvas.width !== img.width || canvas.height !== img.height) { canvas.width = img.width; canvas.height = img.height; }
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0);
}

/**
 * @param {HTMLElement} root where the view goes (emptied)
 * @param {{ t: (key: string, vars?: object) => string, reduced?: boolean, countdown?: number }} o
 */
export function createStoryView(root, { t, reduced = false, countdown = 15 } = {}) {
  root.replaceChildren();
  root.classList.add('story');
  root.classList.toggle('reduced', reduced);
  const board = el('ol', { class: 'board', 'data-role': 'board' });
  const line = el('div', { class: 'timeline', 'data-role': 'timeline' });
  const ask = el('div', { class: 'ask', 'data-role': 'ask', hidden: true });
  root.append(board, ask, line);
  let cards = [], slots = [], segs = [], urls = [], timer = null;

  const api = {
    /** The plan's keyframes and clips as empty cards and slots. */
    setPlan(plan, { size }) {
      for (const u of urls) URL.revokeObjectURL(u);
      urls = []; board.replaceChildren(); line.replaceChildren();
      const [W, H] = size.split('x').map(Number);
      board.dataset.shape = W > H ? 'wide' : W < H ? 'tall' : 'square';
      cards = plan.shots.map((s, k) => {
        const soft = el('canvas', { class: 'soft', 'aria-hidden': 'true' });
        const sharp = el('canvas', { class: 'sharp', role: 'img', 'aria-label': t('story.keyframe', { n: k + 1, s: 3 * k }) });
        const text = el('p', { class: 'text', 'data-photo': s.image ? '1' : null }, s.image ? t(s.image === 'start' ? 'story.startPhoto' : 'story.endPhoto') : s.prompt);
        const li = el('li', { class: 'card pending', 'data-k': k },
          el('div', { class: 'frame' }, soft, sharp), el('p', { class: 'when' }, `${3 * k} s`), text);
        board.append(li);
        return { li, soft, sharp, text };
      });
      slots = plan.clips.map((c, i) => {
        const strip = el('div', { class: 'strip' }, ...[0, 1, 2].map(() => el('canvas', { 'aria-hidden': 'true' })));
        const bar = el('progress', { max: 4, value: 0, 'aria-label': t('story.clip', { n: i + 1 }) });
        const li = el('li', { class: 'slot pending', 'data-i': i }, strip, bar, el('p', { class: 'text' }, c));
        cards[i].li.after(li);
        return { li, strip, bar, video: null };
      });
      line.dataset.count = String(plan.clips.length);
      segs = plan.clips.map((_, i) => {
        const b = el('button', { type: 'button', class: 'seg pending', disabled: true, 'aria-label': t('story.play', { a: 3 * i, b: 3 * (i + 1) }) }, `${3 * i}–${3 * (i + 1)} s`);
        b.addEventListener('click', () => slots[i].video?.play?.());
        line.append(b);
        return b;
      });
    },
    /** A keyframe's step estimate (soft) or the keyframe itself (sharp). */
    keyframe(k, { preview, image, done }) {
      const c = cards[k];
      if (!c) return;
      c.li.classList.remove('pending');
      if (preview) { paint(c.soft, preview); c.li.classList.add('painting'); }
      if (done && image) {
        paint(c.sharp, image);
        if (!c.soft.width) paint(c.soft, image);
        c.li.classList.remove('painting');
        c.li.classList.add('ready');
      }
    },
    /** A step of a clip, with three frames of its estimate. */
    clipStep(i, { index, count, previews }) {
      const s = slots[i];
      if (!s) return;
      s.li.classList.remove('pending'); s.li.classList.add('running');
      s.bar.max = count; s.bar.value = index;
      (previews || []).forEach((p, j) => paint(s.strip.children[j], p));
      segs[i].classList.remove('pending'); segs[i].classList.add('running');
    },
    /** A clip made: its slot plays it, its segment of the timeline is done. */
    clipDone(i, { blob }) {
      const s = slots[i];
      if (!s) return;
      const url = URL.createObjectURL(blob); urls.push(url);
      s.video = el('video', { src: url, muted: true, loop: true, playsinline: true, autoplay: reduced ? null : true, controls: reduced ? true : null });
      s.video.muted = true;
      s.strip.replaceWith(s.video);
      s.bar.value = s.bar.max;
      s.li.classList.remove('running'); s.li.classList.add('ready');
      segs[i].classList.remove('running'); segs[i].classList.add('ready'); segs[i].disabled = false;
    },
    /** A keyframe's text, editable (the "Change" step). */
    editable(on, onEdit) {
      cards.forEach((c, k) => {
        if (c.text.querySelector('textarea') || !on) {
          if (!on && c.text.dataset.edit) { c.text.textContent = c.text.querySelector('textarea')?.value ?? c.text.textContent; delete c.text.dataset.edit; }
          return;
        }
        if (c.li.querySelector('canvas.sharp') && c.text.textContent && !c.text.dataset.photo) {
          const ta = el('textarea', { rows: 3, 'aria-label': t('story.keyframe', { n: k + 1, s: 3 * k }) });
          ta.value = c.text.textContent;
          const again = el('button', { type: 'button', class: 'ghost' }, t('story.repaint'));
          again.addEventListener('click', () => onEdit(k, ta.value));
          c.text.dataset.edit = '1';
          c.text.replaceChildren(ta, again);
        }
      });
    },
    /**
     * Ask "Continue" / "Change" with a countdown that continues by itself.
     * @returns {Promise<'continue'|'change'>}
     */
    askContinue() {
      clearInterval(timer);
      const go = el('button', { type: 'button', class: 'primary', 'data-action': 'story-continue' });
      const change = el('button', { type: 'button', class: 'ghost', 'data-action': 'story-change' }, t('story.change'));
      const clock = el('progress', { max: countdown, value: countdown, 'aria-hidden': 'true' });
      ask.replaceChildren(el('p', {}, t('story.look')), el('p', { class: 'actions' }, go, change), clock);
      ask.hidden = false;
      let left = countdown;
      const label = () => { go.textContent = t('story.continue', { s: left }); clock.value = left; };
      label();
      return new Promise(resolve => {
        const done = what => { clearInterval(timer); timer = null; ask.hidden = true; resolve(what); };
        go.addEventListener('click', () => done('continue'));
        change.addEventListener('click', () => done('change'));
        timer = setInterval(() => { left--; label(); if (left <= 0) done('continue'); }, 1000);
      });
    },
    /** Ask "Continue" without a countdown (after a change). */
    askAfterChange() {
      clearInterval(timer);
      const go = el('button', { type: 'button', class: 'primary', 'data-action': 'story-continue' }, t('story.continueNow'));
      ask.replaceChildren(el('p', {}, t('story.changed')), el('p', { class: 'actions' }, go));
      ask.hidden = false;
      return new Promise(resolve => go.addEventListener('click', () => { ask.hidden = true; resolve('continue'); }));
    },
    dispose() {
      clearInterval(timer);
      for (const u of urls) URL.revokeObjectURL(u);
      urls = [];
      root.replaceChildren();
    },
  };
  return api;
}
