// SPDX-License-Identifier: Apache-2.0 AND MIT
// Copyright (c) 2026 UtopiaIA
// Portions Copyright (c) 2026 Miguel Ángel Durán (runonweb.ai, MIT; see LICENSES/MIT-runonweb.txt):
//   reading the character list of the recogniser from its inference.yml, with
//   the YAML quoting of single characters (packages/runonweb/src/ocr/index.ts:391-416).
//
// The characters a PP-OCR recogniser can write, in the order of its output
// classes. The CTC head has one class per character plus a blank before them
// and a space after them, so a model whose last dimension is not the list
// length plus two is not the model this list belongs to.

import { AiError } from '../core/errors.js';
import { unescapeDouble, yamlTrim } from './config.js';

/** Value of one list item of the dictionary, as YAML writes single characters. */
export function unquoteItem(value) {
  const v = yamlTrim(value);
  if (v === "''" || v === '""') return '';
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return unescapeDouble(v.slice(1, -1));
  return v;
}

/**
 * The `character_dict` list of a recogniser's inference.yml.
 * @param {string} yml
 * @returns {string[]}
 */
export function parseCharacterDict(yml) {
  const text = String(yml).replace(/\r\n/g, '\n');
  const at = /^( *)character_dict:[ \t]*$/m.exec(text);
  if (!at) throw new AiError('model-mismatch', 'the recognition model has no character list');
  const keyIndent = at[1].length;
  const chars = [];
  let itemIndent = -1;
  for (const line of text.slice(at.index + at[0].length).split('\n').slice(1)) {
    if (!yamlTrim(line)) continue;
    const m = /^( *)-(?:[ \t](.*))?$/.exec(line);
    const indent = line.length - line.replace(/^ +/, '').length;
    if (!m) {
      if (indent <= keyIndent || chars.length) break;
      continue;
    }
    if (itemIndent < 0) itemIndent = m[1].length;
    if (m[1].length !== itemIndent) break;
    if (m[1].length < keyIndent) break;
    chars.push(unquoteItem(m[2] ?? ''));
  }
  if (chars.length < 100) throw new AiError('model-mismatch', 'the character list of the recognition model looks empty');
  for (const c of chars) {
    if ([...c].length !== 1) throw new AiError('model-mismatch', 'the character list has an entry that is not one character');
  }
  return chars;
}

/**
 * The output classes of the CTC head: blank, the characters, then a space.
 * @param {string[]} chars
 * @returns {string[]}
 */
export function ctcVocabulary(chars) {
  return ['', ...chars, ' '];
}

/**
 * Check that a recogniser's number of output classes fits a vocabulary.
 * @param {number} classes the last dimension of the recogniser's output
 * @param {string[]} vocab
 */
export function checkClasses(classes, vocab) {
  if (classes !== vocab.length) {
    throw new AiError('model-mismatch', `the recogniser has ${classes} output classes and its character list makes ${vocab.length}`, { details: { classes, vocab: vocab.length } });
  }
}
