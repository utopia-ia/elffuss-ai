#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// Makes the fixtures of the OCR site, all own work, and their entries in
// tests/fixtures/SOURCES.json:
//   tests/fixtures/ocr/factura.png        a Spanish invoice, Archivo font (SIL OFL 1.1, tests/fonts/)
//   tests/fixtures/ocr/foto-factura.jpg   the same, turned 1.5 degrees, with noise, JPEG quality 70
//   tests/fixtures/ocr/exclamacion.png    «¡Hola! ¿Qué tal?» (the model has no «¡»)
//   tests/fixtures/ocr/carpeta/           a folder with every kind of file the site meets
//   tests/fixtures/ocr/tiff/              TIFF files in every layout and compression, by the libtiff tools
//   tests/fixtures/ocr/expected.json, carpeta.expected.{json,md,zip.txt}   what the site must give
//
//   ELFFUSS_PLAYWRIGHT_DIR=<node_modules with playwright> node scripts/make-fixtures.mjs [--expected-only]
//
// Chrome (through Playwright) renders the text and writes the PDF; the libtiff
// tools (ppm2tiff, tiffcp, tiffset, tiffmedian, tiff2rgba) write the TIFF
// files. The bytes depend on the versions of both, so a new run may change the
// images; the texts and the expected results do not change. --expected-only
// rewrites only the expected results (after a change of the export format).

import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bilevel, grey, colour, grey16 } from '../tests/unit/ocr-tiff-patterns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests', 'fixtures', 'ocr');
const SCRIPT = 'scripts/make-fixtures.mjs';

// ── what is drawn ──────────────────────────────────────────────────────────
// A row is a string, or several strings drawn apart on one row (two boxes for
// the detector, one row of text). The expected text joins them with a space.

/** The invoice of the contract (docs/app-contract.md), with its last row in two columns. */
export const INVOICE = {
  width: 1600, height: 1000, size: 48, top: 80, step: 105, gap: 120,
  rows: [
    'FACTURA Nº 2026/0147',
    'Panadería La Espiga, S. L.',
    'Calle del Olmo 12, 3º A, 28801 Alcalá de Henares',
    'Concepto: revisión anual del horno de leña',
    '¿Incluye desplazamiento? Sí, dentro de la zona.',
    'Importe: 1.234,56 € (IVA incluido)',
    '«Gracias por su confianza»',
    ['Ñandú, pingüino y cigüeña', '· ÁÉÍÓÚÜ'],
  ],
};
export const EXCLAMATION = { width: 1000, height: 300, size: 56, top: 110, step: 0, rows: ['¡Hola! ¿Qué tal?'] };
export const FEBRUARY = {
  width: 1400, height: 700, size: 44, top: 70, step: 110,
  rows: ['FACTURA Nº 2026/0212', 'Ferretería El Clavo, S. A.', 'Avenida de la Paz 7, 41001 Sevilla', 'Concepto: tornillos, tuercas y arandelas', 'Importe: 86,40 € (IVA incluido)'],
};
export const MINUTES = [
  ['ACTA DE LA REUNIÓN DE VECINOS', 'Comunidad de la calle Mayor 5, Toledo', 'Asistentes: once propietarios de doce.', 'Primer punto: arreglo del ascensor.', 'Se aprueba pedir tres presupuestos.'],
  ['Segundo punto: limpieza del portal.', 'Se cambia de empresa el próximo mes.', 'Ruegos y preguntas: ninguno.', 'Firma la presidenta de la comunidad.'],
];
export const LETTER = [
  { width: 1700, height: 520, size: 44, top: 70, step: 140, rows: ['CARTA DE PRUEBA', 'Esta página es una imagen en blanco y negro.', 'Se lee igual que una imagen normal.'] },
  { width: 1700, height: 420, size: 44, top: 90, step: 150, rows: ['Segunda página del mismo archivo.', 'Gracias por leer hasta aquí.'] },
];

const rowText = r => (Array.isArray(r) ? r.join(' ') : r);
const rowLines = r => (Array.isArray(r) ? r : [r]);
export const textOf = spec => spec.rows.map(rowText).join('\n');

// ── helpers ────────────────────────────────────────────────────────────────

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, buf) => { const p = join(OUT, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, buf); return p; };

function playwright() {
  const dir = process.env.ELFFUSS_PLAYWRIGHT_DIR;
  if (!dir) throw new Error('set ELFFUSS_PLAYWRIGHT_DIR to a node_modules directory that contains playwright');
  return import('node:module').then(m => m.createRequire(join(dirname(dir), 'resolve-from-here.cjs'))('playwright'));
}

const fontCss = () => `@font-face { font-family: Archivo; src: url(data:font/woff2;base64,${readFileSync(join(ROOT, 'tests', 'fonts', 'archivo-latin.woff2')).toString('base64')}) format('woff2'); font-weight: 100 900; }`;

function rowsHtml(spec) {
  return spec.rows.map((r, i) => `<div style="top:${spec.top + i * spec.step}px">${rowLines(r).map(s => `<span>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`).join('')}</div>`).join('');
}

async function renderPng(page, spec) {
  await page.setViewportSize({ width: spec.width, height: spec.height });
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>fixture</title><style>${fontCss()}
html,body{margin:0;background:white} body{width:${spec.width}px;height:${spec.height}px;position:relative;font-family:Archivo;color:black}
div{position:absolute;left:96px;white-space:pre;line-height:1;font-size:${spec.size}px;font-weight:400} span+span{margin-left:${spec.gap || 0}px}</style>${rowsHtml(spec)}`);
  await page.evaluate(() => document.fonts.ready);
  return page.screenshot({ type: 'png' });
}

/** Re-encode a PNG in the page: turned, with noise (a fixed sequence), as JPEG. */
async function toJpeg(page, png, { quality, degrees = 0, noise = 0 }) {
  const b64 = await page.evaluate(async ({ src, quality, degrees, noise }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    if (noise) {
      const d = ctx.getImageData(0, 0, c.width, c.height);
      let s = 0x2f6b9d3c;
      const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < d.data.length; i += 4) {
        const n = (rnd() + rnd() + rnd() - 1.5) * noise;
        for (let k = 0; k < 3; k++) d.data[i + k] = Math.max(0, Math.min(255, d.data[i + k] + n));
      }
      ctx.putImageData(d, 0, 0);
    }
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, { src: 'data:image/png;base64,' + png.toString('base64'), quality, degrees, noise });
  return Buffer.from(b64, 'base64');
}

/** Grey bytes (one per pixel) of a PNG, read in the page. */
async function greyOf(page, png) {
  const b64 = await page.evaluate(async src => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const g = new Uint8Array(c.width * c.height);
    for (let i = 0; i < g.length; i++) g[i] = Math.round(0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]);
    let bin = '';
    for (let i = 0; i < g.length; i += 0x8000) bin += String.fromCharCode(...g.subarray(i, i + 0x8000));
    return btoa(bin);
  }, 'data:image/png;base64,' + png.toString('base64'));
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function minutesPdf(page) {
  const pages = MINUTES.map(rows => `<section>${rows.map(r => `<p>${r}</p>`).join('')}</section>`).join('');
  await page.setContent(`<!doctype html><meta charset="utf-8"><title>acta</title><style>${fontCss()}
@page { size: A4; margin: 25mm; } html,body{margin:0;background:white;color:black;font-family:Archivo;font-size:15pt}
section{break-after:page} section:last-child{break-after:auto} p{margin:0 0 15pt;line-height:1.2;white-space:pre}</style>${pages}`);
  await page.evaluate(() => document.fonts.ready);
  return neutralInfo(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
}

/**
 * Chrome writes its user agent, which names the system it runs on, as the PDF's
 * creator, and the moment it printed as its dates. Replace them in place (same
 * length, so every byte offset of the file holds) with a neutral creator and a
 * fixed date: the file says nothing of the machine and comes out the same each time.
 */
export function neutralInfo(pdf) {
  const text = Buffer.from(pdf).toString('latin1');
  const out = text
    .replace(/\/Creator \((?:\\.|[^\\)])*\)/g, m => `/Creator (${'Elffuss test fixtures'.padEnd(m.length - '/Creator ()'.length, ' ')})`)
    .replace(/\/(CreationDate|ModDate) \(D:(\d{14})([^)]*)\)/g, (m, key, d, tz) => `/${key} (D:20260101000000${"+00'00'".padEnd(tz.length, ' ').slice(0, tz.length)})`);
  if (out.length !== text.length) throw new Error('the PDF changed size');
  return Buffer.from(out, 'latin1');
}

const pbm = (w, h, black) => {
  const rb = Math.ceil(w / 8), out = Buffer.alloc(rb * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (black(x, y)) out[y * rb + (x >> 3)] |= 0x80 >> (x & 7);
  return Buffer.concat([Buffer.from(`P4\n${w} ${h}\n`), out]);
};
const pgm = (w, h, bytes) => Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(bytes)]);

// ── the TIFF files of the decoder tests ────────────────────────────────────

/** Name → how libtiff makes it, from which pattern. */
export const TIFF_CASES = {
  'bl-g4': ['bl', ['-c', 'g4']],
  'bl-g4-lsb': ['bl', ['-c', 'g4', '-f', 'lsb2msb']],
  'bl-g3-1d': ['bl', ['-c', 'g3:1d']],
  'bl-g3-2d': ['bl', ['-c', 'g3:2d']],
  'bl-g3-fill': ['bl', ['-c', 'g3:2d:fill']],
  'bl-g3-strips': ['bl', ['-c', 'g3:2d', '-r', '5']],
  'bl-packbits': ['bl', ['-c', 'packbits']],
  'gr-lzw2': ['gr', ['-c', 'lzw:2']],
  'gr-zip2': ['gr', ['-c', 'zip:2']],
  'gr-tiles': ['gr', ['-c', 'lzw', '-t', '-w', '64', '-l', '32']],
  'gr-be': ['gr', ['-c', 'lzw', '-B']],
  'co-sep': ['co', ['-c', 'lzw', '-p', 'separate']],
  'co-tiles': ['co', ['-c', 'zip:2', '-t', '-w', '48', '-l', '32']],
  'co-be2': ['co', ['-c', 'lzw:2', '-B']],
};

function makeTiffs(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'elffuss-ai-tiff-'));
  try {
    const bl = bilevel(), gr = grey(), co = colour(), g16 = grey16();
    writeFileSync(join(tmp, 'bl.pbm'), pbm(bl.width, bl.height, (x, y) => bl.data[y * bl.width + x]));
    writeFileSync(join(tmp, 'gr.pgm'), pgm(gr.width, gr.height, gr.data));
    writeFileSync(join(tmp, 'co.ppm'), Buffer.concat([Buffer.from(`P6\n${co.width} ${co.height}\n255\n`), Buffer.from(co.data)]));
    for (const base of ['bl', 'gr', 'co']) run('ppm2tiff', ['-c', 'none', join(tmp, `${base}.${base === 'bl' ? 'pbm' : base === 'gr' ? 'pgm' : 'ppm'}`), join(tmp, `${base}.tif`)]);
    for (const [name, [base, args]] of Object.entries(TIFF_CASES)) run('tiffcp', [...args, join(tmp, `${base}.tif`), join(dir, `${name}.tif`)]);
    writeFileSync(join(tmp, 'g16.raw'), Buffer.from(g16.data.buffer));
    run('raw2tiff', ['-w', String(g16.width), '-l', String(g16.height), '-d', 'short', '-b', '1', '-c', 'lzw:2', join(tmp, 'g16.raw'), join(dir, 'g16-lzw2.tif')]);
    run('tiffcp', ['-c', 'lzw', join(tmp, 'gr.tif'), join(dir, 'gr-orient6.tif')]);
    run('tiffset', ['-s', '274', '6', join(dir, 'gr-orient6.tif')]);
    run('tiffcp', [join(dir, 'bl-g4.tif'), join(dir, 'gr-lzw2.tif'), join(dir, 'multi.tif')]);
    run('tiffmedian', ['-c', 'lzw', join(tmp, 'co.tif'), join(dir, 'co-palette.tif')]);
    run('tiff2rgba', ['-c', 'none', join(dir, 'co-palette.tif'), join(dir, 'co-palette-rgba.tif')]);
    // JPEG inside TIFF (colour as YCbCr, and grey), with libtiff's own decoding to compare with.
    for (const base of ['co', 'gr']) {
      run('tiffcp', ['-c', 'jpeg:90', '-r', '32', join(tmp, `${base}.tif`), join(dir, `${base}-jpeg.tif`)]);
      run('tiff2rgba', ['-c', 'none', join(dir, `${base}-jpeg.tif`), join(dir, `${base}-jpeg-rgba.tif`)]);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── the folder ─────────────────────────────────────────────────────────────

const FAKE = {
  // A HEIC header (ftyp box, brand heic) with nothing an image decoder can use.
  heic: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('mif1heic', 'latin1'), Buffer.alloc(40, 0x2a)]),
  // A PNG signature and an IHDR-shaped chunk of rubbish.
  brokenPng: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR', 'latin1'), Buffer.alloc(13, 0xee), Buffer.alloc(32, 0x5a)]),
  dsStore: Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('Bud1', 'latin1'), Buffer.alloc(56, 0)]),
  thumbs: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(56, 0)]),
};
const README = 'Esta carpeta es de prueba para la herramienta de lectura de texto.\n';

// ── expected results ───────────────────────────────────────────────────────

/** The site's own modules (export, pdf page size), from a build of the site. */
async function siteModules() {
  const { buildSite } = await import('./build.mjs');
  const { sites } = await import('../deploy/sites.mjs');
  const all = sites(ROOT);
  const out = mkdtempSync(join(tmpdir(), 'elffuss-ai-fixtures-'));
  buildSite({ root: ROOT, site: all.find(s => s.site === 'ocr'), sites: all, channel: 'test', buildId: 'fixtures0000', outDir: out });
  const v = join(out, 'ocr', 'v', 'fixtures0000');
  const mod = f => import(pathToFileURL(join(v, f)).href);
  return { out, exp: await mod('export.js'), pdf: await mod('pdf.js'), folder: await mod('folder.js') };
}

function mediaBox(pdf) {
  const m = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf.toString('latin1'));
  if (!m) throw new Error('no MediaBox in the PDF');
  return { width: Number(m[3]) - Number(m[1]), height: Number(m[4]) - Number(m[2]) };
}

/** The projection of the JSON document the browser test compares: no build, device, scores or boxes. */
export function projection(doc) {
  const { build, device, fallback, ...rest } = doc;
  return {
    ...rest,
    files: doc.files.map(f => {
      if (!f.pages) return f;
      const { device: d, ...g } = f;
      return { ...g, pages: f.pages.map(p => (p.error ? p : { page: p.page, width: p.width, height: p.height, text: p.text, lines: p.lines.map(l => l.text) })) };
    }),
  };
}

async function expected() {
  const { out, exp, pdf, folder } = await siteModules();
  try {
    const registry = JSON.parse(readFileSync(join(ROOT, 'registry', 'tasks.json'), 'utf8'));
    const modelId = registry.tasks.ocr.default, model = registry.models[modelId];
    const dir = join(OUT, 'carpeta');
    const listing = [];
    const walk = (d, prefix = '') => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('._')) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(d, e.name), rel); else listing.push(rel);
      }
    };
    walk(dir);
    const lineObjs = rows => rows.flatMap(rowLines).map(text => ({ text, score: 1, box: { xmin: 0, ymin: 0, xmax: 0, ymax: 0 }, polygon: [] }));
    const page = (n, w, h, rows) => ({ page: n, width: w, height: h, text: rows.map(rowText).join('\n'), lines: lineObjs(rows) });
    const box = mediaBox(readFileSync(join(dir, 'notas', 'acta.pdf')));
    const a4 = pdf.pageSize(box.width, box.height);
    const known = {
      'escaneos/carta.tif': { type: 'image/tiff', pages: LETTER.map((p, i) => page(i + 1, p.width, p.height, p.rows)) },
      'facturas/2026/enero.png': { type: 'image/png', pages: [page(1, INVOICE.width, INVOICE.height, INVOICE.rows)] },
      'facturas/2026/FEBRERO.JPG': { type: 'image/jpeg', pages: [page(1, FEBRUARY.width, FEBRUARY.height, FEBRUARY.rows)] },
      'notas/acta.pdf': { type: 'application/pdf', pages: MINUTES.map((rows, i) => page(i + 1, a4.width, a4.height, rows)) },
      'fotos/escaneo.heic': { type: 'image/heic', status: 'skipped', reason: 'unsupported-format' },
      'fotos/rota.png': { type: 'image/png', status: 'error', error: 'decode-failed' },
      'notas/vacio.png': { type: null, status: 'error', error: 'decode-failed' },
      'leeme.txt': { type: null, status: 'skipped', reason: 'unsupported-format' },
      '.DS_Store': { status: 'skipped', reason: 'hidden' },
      'fotos/Thumbs.db': { status: 'skipped', reason: 'hidden' },
    };
    const items = listing.sort(folder.comparePaths).map(path => {
      const k = known[path];
      if (!k) throw new Error(`no expectation for carpeta/${path}`);
      const size = readFileSync(join(dir, ...path.split('/'))).length;
      return { path, size, type: k.type ?? null, status: k.status || 'ok', reason: k.reason, error: k.error, pages: k.pages };
    });
    const texts = lang => {
      const s = { ...JSON.parse(readFileSync(join(ROOT, 'shared', `strings.${lang}.json`), 'utf8')), ...JSON.parse(readFileSync(join(ROOT, 'apps', 'ocr', `strings.${lang}.json`), 'utf8')) };
      const fill = (x, v) => x.replace(/\{(\w+)\}/g, (m, key) => (key in v ? String(v[key]) : m));
      return {
        s,
        t: {
          title: s['export.title'],
          header: fill(s['export.header'], { tool: 'ocr.elffuss.com', model: model.name[lang], author: model.base.author, license: model.license }),
          page: s['page.title'],
          noText: s['export.noText'],
          reasons: Object.fromEntries(['hidden', 'unsupported-format', 'pdf-password', 'decode-failed', 'too-large', 'run-failed', 'no-text', 'not-processed'].map(r => [r, s['reason.' + r]])),
        },
      };
    };
    const { s, t } = texts('es');
    const md = exp.markdown(items, t);
    const json = exp.jsonDocument(items, { tool: 'ocr.elffuss.com', build: 'test', model: exp.modelInfo(modelId, model), device: 'wasm', fallback: null });
    const zip = exp.zipEntries(items, { dir: s['export.base'], md: `${s['export.base']}.md`, json: `${s['export.base']}.json` }, { markdown: md, json });
    write('carpeta.expected.md', md);
    write('carpeta.expected.json', JSON.stringify(projection(JSON.parse(json)), null, 2) + '\n');
    write('carpeta.expected.zip.txt', zip.map(e => e.name).join('\n') + '\n');
    write('expected.json', JSON.stringify({
      'factura.png': { text: textOf(INVOICE), lines: INVOICE.rows.flatMap(rowLines), width: INVOICE.width, height: INVOICE.height },
      'foto-factura.jpg': { text: textOf(INVOICE), maxCharacterErrorRate: 0.02 },
      'exclamacion.png': { written: textOf(EXCLAMATION), reference: 'golden-exclamacion.txt' },
    }, null, 2) + '\n');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

// ── SOURCES.json ───────────────────────────────────────────────────────────

const PURPOSE = {
  'factura.png': 'Spanish invoice; its text must come out exactly, on WebGPU and on WebAssembly',
  'foto-factura.jpg': 'the invoice as a poor photo (turned, noise, JPEG); character error rate at most 2 %',
  'exclamacion.png': 'a sentence with «¡», which the model cannot write; compared with its golden reference',
  'expected.json': 'the expected texts of the single images',
  'carpeta.expected.json': 'what the JSON export of carpeta/ must be (without build, device, scores and boxes)',
  'carpeta.expected.md': 'what the Markdown export of carpeta/ must be',
  'carpeta.expected.zip.txt': 'the file list the ZIP export of carpeta/ must have',
};
const purposeOf = rel => PURPOSE[rel]
  || (rel.startsWith('carpeta/') ? 'a file of the test folder (images, PDF, TIFF, broken, empty, hidden and unsupported files)' : null)
  || (rel.startsWith('tiff/') ? 'a TIFF file made by the libtiff tools for the TIFF decoder test' : null)
  || 'OCR fixture';

function updateSources(files) {
  const p = join(ROOT, 'tests', 'fixtures', 'SOURCES.json');
  const src = JSON.parse(readFileSync(p, 'utf8'));
  const keep = src.files.filter(f => !files.has(f.path));
  for (const [path, entry] of files) keep.push({ path, ...entry });
  src.files = keep.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  writeFileSync(p, JSON.stringify(src, null, 2) + '\n');
}

function listFixtures() {
  const out = [];
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.name.startsWith('._') && !e.name.startsWith('golden-')) out.push(p); } };
  walk(OUT);
  return out;
}

async function main(argv) {
  const only = argv.includes('--expected-only');
  if (!only) {
    rmSync(join(OUT, 'carpeta'), { recursive: true, force: true });
    rmSync(join(OUT, 'tiff'), { recursive: true, force: true });
    mkdirSync(join(OUT, 'tiff'), { recursive: true });
    makeTiffs(join(OUT, 'tiff'));
    const { chromium } = await playwright();
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 1 });
      const invoice = await renderPng(page, INVOICE);
      write('factura.png', invoice);
      write('foto-factura.jpg', await toJpeg(page, invoice, { quality: 0.7, degrees: 1.5, noise: 24 }));
      write('exclamacion.png', await renderPng(page, EXCLAMATION));
      write('carpeta/facturas/2026/enero.png', invoice);
      write('carpeta/facturas/2026/FEBRERO.JPG', await toJpeg(page, await renderPng(page, FEBRUARY), { quality: 0.9 }));
      write('carpeta/notas/acta.pdf', await minutesPdf(page));
      write('carpeta/notas/vacio.png', Buffer.alloc(0));
      write('carpeta/fotos/rota.png', FAKE.brokenPng);
      write('carpeta/fotos/escaneo.heic', FAKE.heic);
      write('carpeta/fotos/Thumbs.db', FAKE.thumbs);
      write('carpeta/.DS_Store', FAKE.dsStore);
      write('carpeta/leeme.txt', README);
      // The letter: page 1 bilevel (Group 4), page 2 grey (LZW with predictor).
      const tmp = mkdtempSync(join(tmpdir(), 'elffuss-ai-letter-'));
      try {
        const g1 = await greyOf(page, await renderPng(page, LETTER[0]));
        writeFileSync(join(tmp, 'p1.pbm'), pbm(LETTER[0].width, LETTER[0].height, (x, y) => g1[y * LETTER[0].width + x] < 128));
        const g2 = await greyOf(page, await renderPng(page, LETTER[1]));
        writeFileSync(join(tmp, 'p2.pgm'), pgm(LETTER[1].width, LETTER[1].height, g2));
        run('ppm2tiff', ['-c', 'g4', '-R', '200', join(tmp, 'p1.pbm'), join(tmp, 'p1.tif')]);
        run('ppm2tiff', ['-c', 'lzw:2', '-R', '200', join(tmp, 'p2.pgm'), join(tmp, 'p2.tif')]);
        mkdirSync(join(OUT, 'carpeta', 'escaneos'), { recursive: true });
        run('tiffcp', [join(tmp, 'p1.tif'), join(tmp, 'p2.tif'), join(OUT, 'carpeta', 'escaneos', 'carta.tif')]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      await browser.close();
    }
  }
  await expected();
  const entries = new Map();
  for (const p of listFixtures()) {
    const rel = relative(OUT, p).split(sep).join('/');
    entries.set(`tests/fixtures/ocr/${rel}`, {
      sha256: sha256(readFileSync(p)),
      license: 'own-work',
      source: { script: SCRIPT, author: 'UtopiaIA', note: rel.startsWith('tiff/') ? 'pixel patterns of tests/unit/ocr-tiff-patterns.mjs encoded by the libtiff tools' : 'text rendered with the Archivo font (SIL OFL 1.1)' },
      purpose: purposeOf(rel),
    });
  }
  const golden = join(OUT, 'golden-exclamacion.txt');
  if (existsSync(golden)) {
    const registry = JSON.parse(readFileSync(join(ROOT, 'registry', 'tasks.json'), 'utf8'));
    const id = registry.tasks.ocr.default, parts = registry.models[id].parts;
    entries.set('tests/fixtures/ocr/golden-exclamacion.txt', {
      sha256: sha256(readFileSync(golden)), license: 'own-work',
      source: { script: 'tests/browser/specs/ocr.spec.mjs', author: 'UtopiaIA', note: 'what the model reads in exclamacion.png; written by the browser test with ELFFUSS_AI_WRITE_GOLDEN=1' },
      model: id, revision: parts.rec.revision, revisions: { det: parts.det.revision, rec: parts.rec.revision }, device: 'wasm',
      purpose: 'reference output for exclamacion.png (the model has no «¡»)',
    });
  }
  updateSources(entries);
  console.log(`fixtures: ${entries.size} files listed in tests/fixtures/SOURCES.json`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error('✗ ' + (e.stack || e)); process.exitCode = 1; });
}
