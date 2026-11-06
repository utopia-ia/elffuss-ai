// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The clips made on this site, kept in this site's own IndexedDB (never sent
// anywhere, never in the shared model store): the WAV and what made it. The
// newest LIMIT are kept. Without IndexedDB (a private window that refuses it)
// the history lives in memory for the page's life.

export const LIMIT = 30;
const DB = 'elffuss-audio', STORE = 'clips';

/**
 * @typedef {{ id: string, at: number, mode: 'music'|'sfx'|'speech', title: string, seconds: number, sampleRate: number,
 *   channels: number, seed?: number, voice?: string, lang?: string, speed?: number, steps?: number, prompt?: string,
 *   text?: string, device: string, model: string, wav: Blob }} Clip
 */

/** @returns {{ list(): Promise<Clip[]>, add(c: Clip): Promise<void>, remove(id: string): Promise<void>, clear(): Promise<void> }} */
export function createHistory({ indexedDB: idb = globalThis.indexedDB } = {}) {
  const mem = new Map();
  let dbp = null;
  const db = () => dbp || (dbp = new Promise(resolve => {
    if (!idb) { resolve(null); return; }
    try {
      const r = idb.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' }).createIndex('at', 'at');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    if (!d) return fn(null);
    return new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      let out;
      Promise.resolve(fn(t.objectStore(STORE))).then(v => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = t.onabort = () => reject(t.error);
    });
  };
  const all = s => (s ? new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }) : Promise.resolve([...mem.values()]));
  return {
    async list() {
      const items = await tx('readonly', all);
      return items.sort((a, b) => b.at - a.at);
    },
    async add(clip) {
      await tx('readwrite', s => { if (s) s.put(clip); else mem.set(clip.id, clip); });
      const items = await this.list();
      for (const old of items.slice(LIMIT)) await this.remove(old.id);
    },
    async remove(id) { await tx('readwrite', s => { if (s) s.delete(id); else mem.delete(id); }); },
    async clear() { await tx('readwrite', s => { if (s) s.clear(); else mem.clear(); }); },
  };
}
