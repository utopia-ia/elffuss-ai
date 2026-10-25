// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The catalog works without JavaScript. With it, this asks the model store
// (`has`, with each pinned URL and its size) whether a tool already has one of
// its model variants complete in this browser, and says so on its card. It is
// the only thing the catalog asks the store.
import config from './config.js';
import { createStoreClient } from './sdk/core/store-client.js';
import { loadRegistry, getModel, variantFiles } from './sdk/core/registry.js';

/** True when every file of at least one variant of the model is in the store. */
export async function hasCompleteVariant(store, model) {
  for (const variants of Object.values(model.devices)) {
    for (const v of variants) {
      const files = variantFiles(model, v);
      const answers = await Promise.all(files.map(f => store.has(f.url, f.size)));
      if (answers.every(Boolean)) return true;
    }
  }
  return false;
}

async function main() {
  const cards = [...document.querySelectorAll('article.card[data-model]')];
  if (!cards.length) return;
  const registry = await loadRegistry();
  const store = createStoreClient({ url: config.storeUrl });
  const marks = {};
  try {
    for (const card of cards) {
      const ok = await hasCompleteVariant(store, getModel(registry, card.dataset.model));
      marks[card.dataset.site] = ok;
      const p = card.querySelector('[data-role="stored"]');
      if (p) p.hidden = !ok;
    }
  } catch {
    // Without the store, the catalog is the same page without the marks.
  }
  if (config.testHooks) globalThis.__elffuss = { marks };
  document.documentElement.dataset.shell = 'ready';
}

main();
