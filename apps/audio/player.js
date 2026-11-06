// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// A waveform player for one clip, on the Web Audio API (no media element, so the
// page's policy keeps media-src 'none'): a play/pause button, the waveform on a
// canvas with the played part in the accent colour, and the time. Click or drag
// on the waveform to move; with it focused, space plays or pauses, the arrows
// move a few seconds, Home and End go to the ends. Colours are read from the page's
// CSS variables when painting. Only one player sounds at a time.

import { peaks } from './sdk/audio/index.js';
import { icon } from './icons.js';

let context = null;
let playing = null; // the player that sounds now

const audioContext = () => (context ||= new AudioContext());
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const clock = s => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  node.append(...children.filter(c => c != null && c !== false));
  return node;
}

/**
 * @param {{ channels: Float32Array[], sampleRate: number, t: Function, name: string }} o
 * @returns {{ node: HTMLElement, play(): void, pause(): void, dispose(): void, get playing(): boolean }}
 */
export function createPlayer({ channels, sampleRate, t, name }) {
  const duration = channels[0].length / sampleRate;
  const button = el('button', { class: 'ghost', 'data-icon': true, type: 'button', 'data-action': 'play', 'aria-label': t('player.play') }, icon('play'));
  const canvas = el('canvas', { tabindex: 0, role: 'slider', 'aria-label': t('player.label', { name }), 'aria-valuemin': 0, 'aria-valuemax': Math.round(duration), 'aria-valuenow': 0 });
  const time = el('span', { class: 'muted time', 'data-role': 'time' });
  const node = el('div', { class: 'player', 'data-role': 'player' }, button, canvas, time);
  let buffer = null, source = null, startedAt = 0, offset = 0, raf = 0, wave = null, width = 0;

  const position = () => (source ? Math.min(duration, offset + audioContext().currentTime - startedAt) : offset);
  const draw = () => {
    const w = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio)), h = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (!wave || width !== w) { wave = peaks(channels, Math.max(1, Math.floor(w / devicePixelRatio / 2))); width = w; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    const bars = wave.length / 2, bw = w / bars, mid = h / 2;
    const played = (position() / duration) * w;
    const base = css('--line'), hot = css('--accent');
    for (let i = 0; i < bars; i++) {
      const lo = wave[i * 2], hi = wave[i * 2 + 1];
      const top = mid - Math.max(hi, 0.02) * mid * 0.95, bottom = mid - Math.min(lo, -0.02) * mid * 0.95;
      g.fillStyle = i * bw < played ? hot : base;
      g.fillRect(i * bw + bw * 0.15, top, Math.max(1, bw * 0.7), bottom - top);
    }
    const now = position();
    time.textContent = t('player.time', { now: clock(now), total: clock(duration) });
    canvas.setAttribute('aria-valuenow', String(Math.round(now)));
    canvas.setAttribute('aria-valuetext', clock(now));
  };
  const tick = () => { draw(); if (source) raf = requestAnimationFrame(tick); };
  const setButton = on => {
    button.replaceChildren(icon(on ? 'pause' : 'play'));
    button.setAttribute('aria-label', t(on ? 'player.pause' : 'player.play'));
    node.dataset.playing = String(on);
  };

  function stopSource() {
    if (!source) return;
    source.onended = null;
    try { source.stop(); } catch { /* already stopped */ }
    source.disconnect();
    source = null;
    cancelAnimationFrame(raf);
  }
  async function play() {
    if (playing && playing !== api) playing.pause();
    const ctx = audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!buffer) {
      buffer = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
      channels.forEach((c, i) => buffer.copyToChannel(c, i));
    }
    if (offset >= duration - 0.01) offset = 0;
    stopSource();
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => { offset = duration; stopSource(); setButton(false); playing = null; draw(); };
    startedAt = ctx.currentTime;
    source.start(0, offset);
    playing = api;
    setButton(true);
    tick();
  }
  function pause() {
    offset = position();
    stopSource();
    if (playing === api) playing = null;
    setButton(false);
    draw();
  }
  function seek(s) {
    const was = Boolean(source);
    offset = Math.min(duration, Math.max(0, s));
    if (was) play(); else draw();
  }

  button.addEventListener('click', () => (source ? pause() : play()));
  const fromEvent = e => { const r = canvas.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * duration; };
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); seek(fromEvent(e)); });
  canvas.addEventListener('pointermove', e => { if (canvas.hasPointerCapture(e.pointerId)) seek(fromEvent(e)); });
  canvas.addEventListener('keydown', e => {
    const k = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key];
    if (k) seek(position() + k);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(duration);
    else if (e.key === ' ' || e.key === 'Enter') (source ? pause() : play());
    else return;
    e.preventDefault();
  });
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);
  setButton(false);
  requestAnimationFrame(draw);

  const api = {
    node, play, pause,
    get playing() { return Boolean(source); },
    get duration() { return duration; },
    dispose() { pause(); ro.disconnect(); buffer = null; wave = null; },
  };
  return api;
}
