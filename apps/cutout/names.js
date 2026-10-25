// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Names of what the cutout site saves.

/**
 * File name of a cut-out: the original name without its extension, a suffix,
 * and .png. Folders, control characters and the characters file systems refuse
 * are dropped; an empty result takes `fallback`.
 * @param {string} name the chosen file's name, e.g. "foto.jpg"
 * @param {string} suffix e.g. "sin-fondo"
 * @param {string} [fallback]
 * @returns {string} e.g. "foto-sin-fondo.png"
 */
export function outputName(name, suffix, fallback = 'image') {
  const leaf = String(name ?? '').split(/[\\/]/).pop() || '';
  const base = leaf.normalize('NFC').replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^[.\s]+/, '').trim();
  return `${Array.from(base || fallback).slice(0, 100).join('')}-${suffix}.png`;
}
