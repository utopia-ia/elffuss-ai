// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The reading queue of the ocr site with stand-in documents and reader: list
// order, page by page, at most two decoded pages alive, a file that cannot be
// opened or read reported and passed, one more try at 2560 pixels after a
// reader failure, a store or model failure stopping everything with what was
// read kept, pause and cancel, and files added while reading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readQueue, pageStream, STOP_CODES, MAX_SIDE, RETRY_SIDE } from '../../apps/ocr/queue.js';

const coded = (code, msg = code) => Object.assign(new Error(msg), { code });
const item = (path, extra = {}) => ({ path, status: 'pending', kind: 'image', ...extra });

/** Documents: `pages` per path; a page's input is its name. Counts decoded pages alive. */
function world({ pages = {}, openError = {}, pageError = {}, readError = {}, readErrorOnce = {} } = {}) {
  const log = [];
  let alive = 0, maxAlive = 0;
  const open = async it => {
    log.push(`open ${it.path}`);
    if (openError[it.path]) throw openError[it.path];
    return {
      pages: pages[it.path] ?? 1,
      async page(i) {
        const name = `${it.path}#${i + 1}`;
        if (pageError[name]) throw pageError[name];
        alive++; maxAlive = Math.max(maxAlive, alive);
        await new Promise(r => setTimeout(r, 1));
        return { input: { name, release: () => { alive--; } } };
      },
      close() { log.push(`close ${it.path}`); },
    };
  };
  const read = async (input, { maxSide }) => {
    log.push(`read ${input.name} ${maxSide}`);
    await new Promise(r => setTimeout(r, 2));
    input.release();
    const once = readErrorOnce[input.name];
    if (once && !once.used) { once.used = true; throw once.error; }
    if (readError[input.name]) throw readError[input.name];
    return { text: `text of ${input.name}`, lines: [{ text: `text of ${input.name}`, score: 0.9, box: { xmin: 0, ymin: 0, xmax: 10, ymax: 5 }, polygon: [[0, 0], [10, 0], [10, 5], [0, 5]] }], width: 100, height: 50, device: 'wasm' };
  };
  return { open, read, log, get maxAlive() { return maxAlive; } };
}

test('reads every pending file in order, page by page, keeping two decoded pages at most', async () => {
  const items = [item('a.png'), item('b.pdf', { kind: 'pdf' }), item('skip.txt', { status: 'skipped', reason: 'unsupported-format' }), item('c.png')];
  const w = world({ pages: { 'b.pdf': 3 } });
  const progress = [], done = [];
  const r = await readQueue(items, { open: w.open, read: w.read, onProgress: p => progress.push(`${p.file}/${p.files} ${p.page}/${p.pages}`), onItem: it => done.push(it.path) }, { signal: new AbortController().signal });
  assert.equal(r.stopped, null);
  assert.deepEqual(items.map(i => i.status), ['ok', 'ok', 'skipped', 'ok']);
  assert.deepEqual(items[1].pages.map(p => p.text), ['text of b.pdf#1', 'text of b.pdf#2', 'text of b.pdf#3']);
  assert.deepEqual(items[1].pages[0], { page: 1, width: 100, height: 50, text: 'text of b.pdf#1', lines: [{ text: 'text of b.pdf#1', score: 0.9, box: { xmin: 0, ymin: 0, xmax: 10, ymax: 5 }, polygon: [[0, 0], [10, 0], [10, 5], [0, 5]] }] });
  assert.equal(items[0].device, 'wasm');
  assert.deepEqual(done, ['a.png', 'b.pdf', 'c.png']);
  assert.deepEqual(progress, ['1/3 1/1', '2/3 1/3', '2/3 2/3', '2/3 3/3', '3/3 1/1']);
  assert.ok(w.maxAlive <= 2, `decoded pages alive at once: ${w.maxAlive}`);
  assert.ok(w.log.filter(l => l.startsWith('read')).every(l => l.endsWith(` ${MAX_SIDE}`)));
  assert.ok(w.log.includes('close b.pdf'));
});

test('a file that cannot be opened or decoded is reported and the queue goes on', async () => {
  const items = [item('locked.pdf', { kind: 'pdf' }), item('broken.png'), item('heic.heic', { kind: 'heic' }), item('good.png'), item('half.pdf', { kind: 'pdf' })];
  const w = world({
    pages: { 'half.pdf': 2 },
    openError: { 'locked.pdf': coded('pdf-password'), 'broken.png': new Error('something odd') },
    pageError: { 'heic.heic#1': coded('unsupported-format'), 'half.pdf#2': coded('decode-failed') },
  });
  const r = await readQueue(items, w, { signal: new AbortController().signal });
  assert.equal(r.stopped, null);
  assert.deepEqual(items.map(i => [i.status, i.reason ?? i.error ?? null]), [['skipped', 'pdf-password'], ['error', 'decode-failed'], ['skipped', 'unsupported-format'], ['ok', null], ['ok', null]]);
  assert.deepEqual(items[4].pages.map(p => p.error ?? 'ok'), ['ok', 'decode-failed'], 'a page that fails keeps the others');
});

test('a reader failure is tried once more at 2560 pixels; twice is too large', async () => {
  const items = [item('a.png'), item('b.png'), item('c.png')];
  const w = world({ readErrorOnce: { 'a.png#1': { error: coded('run-failed') } }, readError: { 'b.png#1': coded('run-failed') } });
  const r = await readQueue(items, w, { signal: new AbortController().signal });
  assert.equal(r.stopped, null);
  assert.deepEqual(items.map(i => [i.status, i.error ?? null]), [['ok', null], ['error', 'too-large'], ['ok', null]]);
  assert.deepEqual(w.log.filter(l => l.startsWith('read a.png') || l.startsWith('read b.png')), [`read a.png#1 ${MAX_SIDE}`, `read a.png#1 ${RETRY_SIDE}`, `read b.png#1 ${MAX_SIDE}`, `read b.png#1 ${RETRY_SIDE}`]);
});

test('a failure of the store or the model stops everything and keeps what was read', async () => {
  for (const code of ['store-quota', 'integrity', 'runtime-mismatch', 'model-mismatch']) {
    assert.ok(STOP_CODES.has(code));
    const items = [item('a.png'), item('b.pdf', { kind: 'pdf' }), item('c.png')];
    const w = world({ pages: { 'b.pdf': 2 }, readError: { 'b.pdf#2': coded(code) } });
    const r = await readQueue(items, w, { signal: new AbortController().signal });
    assert.equal(r.stopped?.code, code);
    assert.deepEqual(items.map(i => i.status), ['ok', 'pending', 'pending'], `${code}: the half-read file is left as not read`);
    assert.equal(items[1].pages, undefined);
  }
});

test('pause waits between pages; cancel stops at once', async () => {
  const items = [item('a.png'), item('b.png'), item('c.png')];
  const w = world();
  let release;
  let paused = new Promise(r => { release = r; });
  const ac = new AbortController();
  let waits = 0;
  const running = readQueue(items, w, {
    signal: ac.signal,
    paused: () => { if (!paused) return undefined; waits++; return paused; },
  });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(items.map(i => i.status), ['pending', 'pending', 'pending'], 'nothing read while paused');
  paused = null;
  release();
  await new Promise(r => setTimeout(r, 1));
  ac.abort();
  const r = await running;
  assert.equal(r.stopped?.code, 'aborted');
  assert.ok(waits >= 1);
  assert.ok(items.some(i => i.status === 'pending'), 'what was not reached stays to read');
});

test('files added while reading are read too', async () => {
  const items = [item('a.png')];
  const w = world();
  const r = await readQueue(items, { ...w, onItem: it => { if (it.path === 'a.png') items.push(item('late.png')); } }, { signal: new AbortController().signal });
  assert.equal(r.stopped, null);
  assert.deepEqual(items.map(i => [i.path, i.status]), [['a.png', 'ok'], ['late.png', 'ok']]);
});

test('pages of a document come in order and the document is closed after its last page', async () => {
  const w = world({ pages: { 'x.pdf': 2 } });
  const got = [];
  for await (const e of pageStream([item('x.pdf'), item('done.png', { status: 'ok' })], w.open)) got.push(`${e.item.path} ${e.index + 1}/${e.count}`);
  assert.deepEqual(got, ['x.pdf 1/2', 'x.pdf 2/2']);
  assert.deepEqual(w.log, ['open x.pdf', 'close x.pdf']);
});
