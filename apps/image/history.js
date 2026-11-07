// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The pictures created on this site, kept only in this browser: the request that
// makes each one again (prompt, seed, steps, shape) and a small preview, in this
// origin's IndexedDB. Nothing is sent anywhere; the newest come first and only
// the last LIMIT are kept. Without IndexedDB (a private window may refuse it) the
// history lives as long as the page.

/** How many pictures the history keeps. */
export const LIMIT = 24;

/**
 * @typedef {{ id: string, at: number, prompt: string, seed: number, steps: number, aspect: string, width: number, height: number, thumb: Blob }} HistoryItem
 */

/**
 * Open the history.
 * @param {{ indexedDB?: IDBFactory, name?: string }} [o]
 */
export function openHistory({ indexedDB: idb = globalThis.indexedDB, name = 'elffuss-image-history' } = {}) {
  let mem = [];
  let dbp = null;
  const db = () => dbp || (dbp = new Promise(resolve => {
    if (!idb) { resolve(null); return; }
    try {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  }));
  const tx = async (mode, fn) => {
    const d = await db();
    if (!d) return null;
    return new Promise(resolve => {
      try {
        const t = d.transaction('items', mode);
        const req = fn(t.objectStore('items'));
        t.oncomplete = () => resolve(req?.result ?? true);
        t.onerror = t.onabort = () => resolve(null);
      } catch { resolve(null); }
    });
  };
  const newestFirst = list => [...list].sort((a, b) => b.at - a.at);
  return {
    /** Every item, newest first. @returns {Promise<HistoryItem[]>} */
    async list() {
      const all = await tx('readonly', s => s.getAll());
      return newestFirst(all || mem);
    },
    /** Add an item and drop the oldest beyond LIMIT. @param {Omit<HistoryItem, 'id'|'at'>} item */
    async add(item) {
      const full = { ...item, id: `${Date.now()}-${item.seed}`, at: Date.now() };
      mem = newestFirst([full, ...mem]).slice(0, LIMIT);
      if (await tx('readwrite', s => s.put(full))) {
        const all = newestFirst(await tx('readonly', s => s.getAll()) || []);
        for (const old of all.slice(LIMIT)) await tx('readwrite', s => s.delete(old.id));
      }
      return full;
    },
    /** Remove every item. */
    async clear() {
      mem = [];
      await tx('readwrite', s => s.clear());
    },
  };
}
