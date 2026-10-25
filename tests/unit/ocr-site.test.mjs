// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The ocr site's own modules, imported from a build of the site (they import
// the SDK by its place in the build): the list of files (paths, hidden and
// system files, natural order, folders dropped or picked with their
// subfolders, type by the first bytes, empty files, repeated paths, the
// summary) and the exports (.txt with form feeds, Markdown escaping, the JSON
// document, the ZIP and its name), checked against the expected files of the
// test folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSite } from '../../scripts/build.mjs';
import { sites as readSites } from '../../deploy/sites.mjs';
import { readZip, crc32 } from '../../sdk/core/zip.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIX = join(ROOT, 'tests', 'fixtures', 'ocr');
const out = mkdtempSync(join(tmpdir(), 'elffuss-ai-ocr-site-'));
const all = readSites(ROOT);
buildSite({ root: ROOT, site: all.find(s => s.site === 'ocr'), sites: all, channel: 'test', buildId: 'unit00000000', outDir: out });
test.after(() => rmSync(out, { recursive: true, force: true }));
const mod = f => import(pathToFileURL(join(out, 'ocr', 'v', 'unit00000000', f)).href);
const folder = await mod('folder.js');
const exp = await mod('export.js');
const pdf = await mod('pdf.js');

const file = (bytes, name = 'x', extra = {}) => Object.assign(new Blob([bytes]), { name, ...extra });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test('paths: normalised, hidden and system files, natural order, the common folder', () => {
  assert.equal(folder.normalizePath('/a\\b/./c/../d.png'), 'a/b/c/d.png');
  assert.equal(folder.normalizePath('Café.png'), 'Café.png');
  for (const p of ['.DS_Store', 'a/.git/config', 'fotos/Thumbs.db', 'x/desktop.ini', '__MACOSX/a.png', '.hidden/x.png']) assert.equal(folder.isHidden(p), true, p);
  for (const p of ['a.png', 'notas/acta.pdf', 'x.y/z.png']) assert.equal(folder.isHidden(p), false, p);
  const sorted = ['b/10.png', 'B/2.png', 'a.png', 'b/1.png', 'b/2.png', 'b/sub/1.png', 'ñ.png', 'n.png', 'o.png'].sort(folder.comparePaths);
  assert.deepEqual(sorted, ['a.png', 'b/1.png', 'B/2.png', 'b/2.png', 'b/10.png', 'b/sub/1.png', 'n.png', 'ñ.png', 'o.png']);
  assert.equal(folder.commonRoot(['carpeta/a.png', 'carpeta/b/c.pdf']), 'carpeta');
  assert.equal(folder.commonRoot(['carpeta/a.png', 'otra/b.png']), null);
  assert.equal(folder.commonRoot(['a.png']), null);
  assert.equal(folder.uniqueAgainst('a/b.png', new Set(['a/b.png', 'a/b (2).png'])), 'a/b (3).png');
  assert.equal(folder.uniqueAgainst('README', new Set(['README'])), 'README (2)');
});

test('picked files and folders keep their relative path', () => {
  const e = folder.entriesFromFiles([file('x', 'a.png', { webkitRelativePath: 'carpeta/sub/a.png' }), file('y', 'b.png')]);
  assert.deepEqual(e.map(x => x.path), ['carpeta/sub/a.png', 'b.png']);
});

/** A stand-in FileSystemEntry tree whose readers answer in batches of `batch`. */
function entryTree(tree, path = '', batch = 2) {
  if (typeof tree === 'string') return { isFile: true, isDirectory: false, fullPath: path, file: (ok) => ok(file(tree, path.split('/').pop())) };
  const children = Object.entries(tree).map(([n, v]) => entryTree(v, `${path}/${n}`, batch));
  return {
    isFile: false, isDirectory: true, fullPath: path,
    createReader() { let i = 0; return { readEntries(ok) { const part = children.slice(i, i + batch); i += batch; setTimeout(() => ok(part), 0); } }; },
  };
}

test('dropped folders are walked with their subfolders, reading every batch', async () => {
  const root = entryTree({ carpeta: { 'a.png': 'a', vacia: {}, sub: { 'b.pdf': 'b', 'c.png': 'c', 'd.png': 'd', deep: { 'e.tif': 'e' } } } }).createReader();
  const [carpeta] = await new Promise(ok => root.readEntries(ok));
  const got = await folder.walkEntry(carpeta);
  assert.deepEqual(got.map(e => e.path).sort(), ['carpeta/a.png', 'carpeta/sub/b.pdf', 'carpeta/sub/c.png', 'carpeta/sub/d.png', 'carpeta/sub/deep/e.tif']);
  const dt = { items: [{ kind: 'file', webkitGetAsEntry: () => carpeta }, { kind: 'file', webkitGetAsEntry: () => entryTree('z', '/suelto.png') }], files: [] };
  assert.equal((await folder.entriesFromDrop(dt)).length, 6);
  // Without entries (a drop made by a script), the plain file list.
  const plain = { items: [{ kind: 'file', webkitGetAsEntry: () => null }], files: [file('q', 'q.png')] };
  assert.deepEqual((await folder.entriesFromDrop(plain)).map(e => e.path), ['q.png']);
});

test('a folder from the directory picker, its name first', async () => {
  const handle = (name, tree) => ({
    kind: 'directory', name,
    async *entries() { for (const [n, v] of Object.entries(tree)) yield [n, typeof v === 'string' ? { kind: 'file', name: n, getFile: async () => file(v, n) } : handle(n, v)]; },
  });
  const got = await folder.walkDirectoryHandle(handle('fotos', { 'a.jpg': 'a', 'viaje': { 'b.png': 'b' } }));
  assert.deepEqual(got.map(e => e.path), ['fotos/a.jpg', 'fotos/viaje/b.png']);
});

test('what each file is comes from its first bytes, never its name', async () => {
  const pdfAfterJunk = file(new Uint8Array([...new TextEncoder().encode('junk\n%PDF-1.7\n')]), 'x');
  const cases = [
    [file(PNG, 'foto.jpg'), 'image', 'image/png'],
    [file(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'a.pdf'), 'image', 'image/jpeg'],
    [file(new TextEncoder().encode('%PDF-1.4'), 'scan'), 'pdf', 'application/pdf'],
    [pdfAfterJunk, 'pdf', 'application/pdf'],
    [file(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]), 'a.png'), 'tiff', 'image/tiff'],
    [file(new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic')]), 'a.heic'), 'heic', 'image/heic'],
    [file(new TextEncoder().encode('hola'), 'a.png'), null, null],
  ];
  for (const [f, kind, type] of cases) assert.deepEqual(await folder.sniffFile(f), { kind, type }, `${f.name} → ${kind}`);
});

test('the list: statuses before reading, natural order, and its summary', async () => {
  const entries = [
    ['notas/vacio.png', ''], ['leeme.txt', 'texto'], ['.DS_Store', 'Bud1'], ['b/10.png', PNG], ['b/2.png', PNG],
    ['scan.pdf', '%PDF-1.4'], ['raro.bin', ''], ['fotos/Thumbs.db', 'x'],
  ].map(([path, bytes]) => ({ path, file: file(bytes, path.split('/').pop()) }));
  const items = await folder.classify(entries);
  assert.deepEqual(items.map(i => [i.path, i.status, i.reason ?? i.error ?? i.kind]), [
    ['.DS_Store', 'skipped', 'hidden'], ['b/2.png', 'pending', 'image'], ['b/10.png', 'pending', 'image'], ['fotos/Thumbs.db', 'skipped', 'hidden'],
    ['leeme.txt', 'skipped', 'unsupported-format'], ['notas/vacio.png', 'error', 'decode-failed'], ['raro.bin', 'skipped', 'unsupported-format'], ['scan.pdf', 'pending', 'pdf'],
  ]);
  assert.deepEqual(folder.summarize(items), { files: 8, images: 2, pdfs: 1, skipped: 5, hidden: 2, bytes: items.reduce((s, i) => s + i.size, 0) });
  assert.equal(folder.MAX_FILES, 65535);
});

const T = {
  title: 'Texto extraído', header: 'Herramienta: x', page: 'Página {n}', noText: 'Archivos sin texto',
  reasons: { hidden: 'oculto', 'unsupported-format': 'formato no admitido', 'pdf-password': 'PDF con contraseña', 'decode-failed': 'no se pudo abrir', 'too-large': 'demasiado grande', 'run-failed': 'no se pudo leer', 'no-text': 'no se encontró texto', 'not-processed': 'no se llegó a leer' },
};
const page = (n, text) => ({ page: n, width: 10, height: 10, text, lines: text ? text.split('\n').map(t => ({ text: t, score: 0.9, box: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 }, polygon: [[0, 0], [1, 0], [1, 1], [0, 1]] })) : [] });

test('a file\'s .txt: each page and a line break, pages separated by a form feed', () => {
  assert.equal(exp.fileText({ pages: [page(1, 'uno\ndos')] }), 'uno\ndos\n');
  assert.equal(exp.fileText({ pages: [page(1, 'a'), page(2, ''), page(3, 'c')] }), 'a\n\f\fc\n');
  assert.equal(exp.fileText({}), '');
});

test('Markdown: recognised text is text, never markup', () => {
  assert.equal(exp.escapeMarkdown('# título\n> cita\n- guion\n+ más\n* estrella\n| tabla\n1. uno\n2) dos\n `code` <b> & \\ ok'),
    '\\# título\n\\> cita\n\\- guion\n\\+ más\n\\* estrella\n\\| tabla\n1\\. uno\n2\\) dos\n \\`code\\` &lt;b> &amp; \\\\ ok');
  assert.equal(exp.escapeMarkdown('Importe: 1.234,56 €'), 'Importe: 1.234,56 €');
});

test('Markdown and JSON of a reading: pages, files without text, what was not reached', () => {
  const items = [
    { path: 'a.pdf', type: 'application/pdf', size: 9, status: 'ok', device: 'wasm', pages: [page(1, 'uno'), { page: 2, error: 'too-large' }, page(3, '')] },
    { path: 'b.png', type: 'image/png', size: 5, status: 'ok', device: 'webgpu', pages: [page(1, '')] },
    { path: 'c.txt', type: null, size: 1, status: 'skipped', reason: 'unsupported-format' },
    { path: 'd.png', type: 'image/png', size: 2, status: 'error', error: 'decode-failed' },
    { path: 'e.png', type: 'image/png', size: 3, status: 'pending' },
    { path: '.x', type: null, size: 1, status: 'skipped', reason: 'hidden' },
  ];
  assert.equal(exp.markdown(items, T), '# Texto extraído\n\nHerramienta: x\n\n## a.pdf\n\n### Página 1\n\nuno\n\n### Página 2\n\n_demasiado grande_\n\n### Página 3\n\n_no se encontró texto_\n\n## Archivos sin texto\n\n- b.png: no se encontró texto\n- c.txt: formato no admitido\n- d.png: no se pudo abrir\n- e.png: no se llegó a leer\n');
  const doc = JSON.parse(exp.jsonDocument(items, { tool: 'ocr.elffuss.com', build: 'b1', model: { id: 'm' }, device: 'wasm', fallback: { from: 'webgpu', reason: 'run-failed' } }));
  assert.equal(doc.schema, 'elffuss-ocr/1');
  assert.deepEqual(doc.fallback, { from: 'webgpu', reason: 'run-failed' });
  assert.deepEqual(doc.files.map(f => f.status), ['ok', 'ok', 'skipped', 'error', 'not-processed', 'skipped']);
  assert.deepEqual(doc.files[0].pages[1], { page: 2, error: 'too-large' });
  assert.deepEqual(doc.files[5], { path: '.x', status: 'skipped', reason: 'hidden' });
  assert.deepEqual(doc.summary, { files: 6, ok: 2, skipped: 2, errors: 1, notProcessed: 1, pages: 3 });
});

test('the ZIP: one .txt per read file in its folder, the Markdown and the JSON; stored, UTF-8 names', () => {
  const items = [{ path: 'carpeta/ñ/a.png', status: 'ok', pages: [page(1, 'hola')] }, { path: 'b.txt', status: 'skipped', reason: 'unsupported-format' }];
  const entries = exp.zipEntries(items, { dir: 'texto', md: 'texto.md', json: 'texto.json' }, { markdown: '# m\n', json: '{}\n' });
  assert.deepEqual(entries.map(e => e.name), ['texto/carpeta/ñ/a.png.txt', 'texto.md', 'texto.json']);
  const zip = exp.zipBytes(entries, new Date(2026, 9, 25, 12, 30));
  const back = readZip(zip);
  assert.deepEqual(back.map(e => [e.name, e.method, (e.flags & 0x800) !== 0, e.crc === crc32(e.data)]), [['texto/carpeta/ñ/a.png.txt', 0, true, true], ['texto.md', 0, true, true], ['texto.json', 0, true, true]]);
  assert.equal(new TextDecoder().decode(back[0].data), 'hola\n');
  assert.equal(exp.zipName('carpeta', new Date(2026, 9, 5, 7, 3)), 'ocr-carpeta-20261005-0703.zip');
  assert.equal(exp.zipName('a/b:c*', new Date(2026, 0, 1, 0, 0)), 'ocr-a_b_c_-20260101-0000.zip');
  assert.equal(exp.zipName('', new Date(2026, 0, 1, 0, 0)), 'ocr-20260101-0000.zip');
});

test('unzip accepts the ZIP, when the tool is there', { skip: !(() => { try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })() }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'elffuss-ai-zip-'));
  try {
    const zip = exp.zipBytes(exp.zipEntries([{ path: 'a/b.png', status: 'ok', pages: [page(1, 'x')] }], { dir: 'texto', md: 'texto.md', json: 'texto.json' }, { markdown: '#\n', json: '{}\n' }));
    const p = join(dir, 't.zip');
    execFileSync('/bin/sh', ['-c', 'cat > "$1"', 'sh', p], { input: zip });
    assert.match(execFileSync('unzip', ['-t', p], { encoding: 'utf8' }), /No errors detected/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the expected files of the test folder are what the export functions give for it', () => {
  const want = JSON.parse(readFileSync(join(FIX, 'carpeta.expected.json'), 'utf8'));
  const listing = readFileSync(join(FIX, 'carpeta.expected.zip.txt'), 'utf8').trim().split('\n');
  // Every file of the folder is in the expected JSON, in the site's order.
  const walk = (d, p = '') => readdirSync(d, { withFileTypes: true }).filter(e => !e.name.startsWith('._')).flatMap(e => (e.isDirectory() ? walk(join(d, e.name), `${p}${e.name}/`) : [`${p}${e.name}`]));
  assert.deepEqual(want.files.map(f => f.path), walk(join(FIX, 'carpeta')).sort(folder.comparePaths));
  assert.deepEqual(listing, [...want.files.filter(f => f.status === 'ok').map(f => `texto/${f.path}.txt`), 'texto.md', 'texto.json']);
  for (const f of want.files.filter(x => x.status !== 'skipped' || x.reason !== 'hidden')) assert.equal(f.size, readFileSync(join(FIX, 'carpeta', ...f.path.split('/'))).length, f.path);
  assert.ok(existsSync(join(FIX, 'carpeta.expected.md')));
});

test('PDF pages: 200 dpi, longest side at most 4000 pixels', () => {
  assert.deepEqual(pdf.pageSize(595.28, 841.89), { scale: 200 / 72, width: 1653, height: 2338 });
  const big = pdf.pageSize(2000, 1000);
  assert.deepEqual([big.width, big.height], [4000, 2000]);
});
