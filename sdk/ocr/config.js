// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The settings of the two PP-OCR models, read from their own inference.yml
// (the files the registry pins), so the pipeline follows the model and not a
// copy of its numbers: thresholds and normalisation of the detector, input
// height of the recogniser. A small YAML reader covers what those files use:
// block mappings and sequences, nested sequences, quoted and plain scalars,
// anchors and aliases.

import { AiError } from '../core/errors.js';

const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Trim the two characters YAML treats as white space (space and tab), nothing else. */
export const yamlTrim = s => String(s).replace(/^[ \t]+|[ \t]+$/g, '');

/** Value of one YAML scalar as written (quoted or plain). */
export function yamlScalar(raw) {
  const v = yamlTrim(raw);
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new SyntaxError('unterminated single-quoted scalar');
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new SyntaxError('unterminated double-quoted scalar');
    return unescapeDouble(v.slice(1, -1));
  }
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (PLAIN_NUMBER.test(v)) return Number(v);
  return v;
}

const ESCAPES = { '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: ' ', L: ' ', P: ' ' };

/** The escapes of a YAML double-quoted scalar. */
export function unescapeDouble(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === undefined) throw new SyntaxError('a double-quoted scalar ends in a backslash');
    if (n in ESCAPES) { out += ESCAPES[n]; continue; }
    const len = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
    if (!len) throw new SyntaxError(`unknown escape \\${n}`);
    const hex = s.slice(i + 1, i + 1 + len);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new SyntaxError(`bad escape \\${n}${hex}`);
    out += String.fromCodePoint(parseInt(hex, 16));
    i += len;
  }
  return out;
}

/** Drop a comment that starts outside quotes (`  # …` or a whole `# …` line). */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) {
        if (quote === "'" && line[i + 1] === "'") { i++; continue; }
        quote = null;
      } else if (quote === '"' && c === '\\') i++;
      continue;
    }
    if ((c === "'" || c === '"') && (i === 0 || /[ \t\-:[{,]/.test(line[i - 1]))) { quote = c; continue; }
    if (c === '#' && (i === 0 || /[ \t]/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

const isItem = text => text === '-' || text.startsWith('- ') || text.startsWith('-\t');

/** `key: value` or `key:`; the key may be quoted. Returns null for a line that is not a mapping entry. */
function splitKey(text) {
  let i;
  if (text.startsWith("'") || text.startsWith('"')) {
    const q = text[0];
    for (i = 1; i < text.length; i++) {
      if (text[i] === q) { if (q === "'" && text[i + 1] === "'") { i++; continue; } break; }
      if (q === '"' && text[i] === '\\') i++;
    }
    if (text[i + 1] !== ':') return null;
    return { key: String(yamlScalar(text.slice(0, i + 1))), value: yamlTrim(text.slice(i + 2)) };
  }
  const m = /^([^:]*?):(?:[ \t]+(.*))?$/.exec(text);
  if (!m || /^[-?][ \t]/.test(text)) return null;
  return { key: yamlTrim(m[1]), value: yamlTrim(m[2] || '') };
}

/**
 * Parse the YAML subset of the PaddleOCR inference files.
 * @param {string} text
 * @returns {any}
 */
export function parseYaml(text) {
  const lines = [];
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = stripComment(raw).replace(/[ \t]+$/, '');
    if (!line || yamlTrim(line) === '---') continue;
    if (/^ *\t/.test(line)) throw new SyntaxError('tabs are not allowed for indentation');
    const indent = line.length - line.replace(/^ +/, '').length;
    lines.push({ indent, text: line.slice(indent) });
  }
  const anchors = new Map();
  let i = 0;

  const value = raw => {
    let v = yamlTrim(raw);
    let anchor = null;
    const a = /^&([^ \t]+)[ \t]*(.*)$/.exec(v);
    if (a) { anchor = a[1]; v = a[2]; }
    if (/^\*[^ \t]+$/.test(v)) {
      const name = v.slice(1);
      if (!anchors.has(name)) throw new SyntaxError(`unknown alias *${name}`);
      return { anchor, scalar: true, value: anchors.get(name) };
    }
    if (v === '[]') return { anchor, scalar: true, value: [] };
    if (v === '{}') return { anchor, scalar: true, value: {} };
    return { anchor, scalar: v !== '', value: v === '' ? undefined : yamlScalar(v) };
  };

  function node(indent) {
    if (i >= lines.length || lines[i].indent < indent) return null;
    return isItem(lines[i].text) ? seq(lines[i].indent) : map(lines[i].indent);
  }

  function nested(parentIndent, allowSameIndentSeq) {
    if (i >= lines.length) return null;
    const l = lines[i];
    if (l.indent > parentIndent || (allowSameIndentSeq && l.indent === parentIndent && isItem(l.text))) return node(l.indent);
    return null;
  }

  function seq(indent) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
      const rest = lines[i].text === '-' ? '' : lines[i].text.slice(2);
      if (!yamlTrim(rest)) { i++; out.push(nested(indent, false)); continue; }
      const inner = rest.length - rest.replace(/^ +/, '').length;
      // The item's content is a node of its own, one level deeper.
      lines[i] = { indent: indent + 2 + inner, text: rest.replace(/^ +/, '') };
      const t = lines[i].text;
      if (isItem(t) || splitKey(t)) { out.push(node(lines[i].indent)); continue; }
      i++;
      const v = value(t);
      if (v.anchor) anchors.set(v.anchor, v.value);
      out.push(v.value === undefined ? null : v.value);
    }
    return out;
  }

  function map(indent) {
    const out = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].text)) {
      const kv = splitKey(lines[i].text);
      if (!kv) throw new SyntaxError(`not a mapping entry: ${lines[i].text.slice(0, 40)}`);
      i++;
      const v = value(kv.value);
      if (v.scalar) out[kv.key] = v.value;
      else out[kv.key] = nested(indent, true);
      if (v.anchor) anchors.set(v.anchor, out[kv.key]);
    }
    return out;
  }

  const root = node(0);
  if (i < lines.length) throw new SyntaxError(`unexpected indentation at: ${lines[i].text.slice(0, 40)}`);
  return root;
}

const num = (v, name, { min = -Infinity, max = Infinity } = {}) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new AiError('model-mismatch', `the model settings have no valid ${name}`);
  return v;
};

const transform = (ops, name) => {
  for (const op of ops || []) if (op && typeof op === 'object' && name in op) return op[name] || {};
  return null;
};

/**
 * Detection settings of a PP-OCR det model (its inference.yml).
 * The resize rule is not in the file: the shortest side is brought up to 736,
 * the longest kept under 4000 (the model's own largest input), both sides
 * rounded to multiples of 32.
 * @param {string} yml
 */
export function parseDetConfig(yml) {
  let doc;
  try { doc = parseYaml(yml); } catch (err) { throw new AiError('model-mismatch', 'the detection settings could not be read', { cause: err }); }
  const post = doc?.PostProcess;
  if (!post || post.name !== 'DBPostProcess') throw new AiError('model-mismatch', 'the detection model is not a DB text detector');
  const ops = doc?.PreProcess?.transform_ops;
  const norm = transform(ops, 'NormalizeImage');
  const decode = transform(ops, 'DecodeImage');
  const mean = norm?.mean ?? [0.485, 0.456, 0.406];
  const std = norm?.std ?? [0.229, 0.224, 0.225];
  if (!Array.isArray(mean) || mean.length !== 3 || !Array.isArray(std) || std.length !== 3 || std.some(s => !(s > 0))) throw new AiError('model-mismatch', 'the detection normalisation is not three means and three deviations');
  if (norm?.order && norm.order !== 'hwc') throw new AiError('model-mismatch', `unexpected normalisation order ${norm.order}`);
  const scale = norm?.scale == null ? 1 / 255 : parseScale(norm.scale);
  return Object.freeze({
    thresh: num(post.thresh ?? 0.3, 'thresh', { min: 0, max: 1 }),
    boxThresh: num(post.box_thresh ?? 0.6, 'box_thresh', { min: 0, max: 1 }),
    maxCandidates: num(post.max_candidates ?? 1000, 'max_candidates', { min: 1 }),
    unclipRatio: num(post.unclip_ratio ?? 1.5, 'unclip_ratio', { min: 0 }),
    mean: Object.freeze(mean.map(v => num(v, 'mean'))),
    std: Object.freeze(std.map(v => num(v, 'std'))),
    scale,
    bgr: (decode?.img_mode ?? 'BGR') === 'BGR',
    limitSideLen: 736,
    maxSideLimit: 4000,
    multiple: 32,
    minSize: 3,
  });
}

/** `1./255.` and the like, without evaluating anything. */
export function parseScale(v) {
  if (typeof v === 'number') return num(v, 'scale', { min: 0 });
  const m = /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(String(v));
  if (!m) throw new AiError('model-mismatch', `unexpected normalisation scale ${String(v).slice(0, 20)}`);
  const r = Number(m[1]) / Number(m[2]);
  return num(r, 'scale', { min: 0 });
}

/**
 * Recognition settings of a PP-OCR rec model (its inference.yml): input
 * height and base width, channel order, and the decoder it was trained for.
 * @param {string} yml
 */
export function parseRecConfig(yml) {
  let doc;
  try { doc = parseYaml(yml); } catch (err) { throw new AiError('model-mismatch', 'the recognition settings could not be read', { cause: err }); }
  if (doc?.PostProcess?.name !== 'CTCLabelDecode') throw new AiError('model-mismatch', 'the recognition model does not use CTC decoding');
  const ops = doc?.PreProcess?.transform_ops;
  const shape = transform(ops, 'RecResizeImg')?.image_shape ?? [3, 48, 320];
  if (!Array.isArray(shape) || shape.length !== 3 || shape[0] !== 3) throw new AiError('model-mismatch', 'unexpected recognition input shape');
  const decode = transform(ops, 'DecodeImage');
  return Object.freeze({
    height: num(shape[1], 'input height', { min: 8, max: 256 }),
    width: num(shape[2], 'input width', { min: 8 }),
    maxWidth: 3200,
    bgr: (decode?.img_mode ?? 'BGR') === 'BGR',
  });
}
