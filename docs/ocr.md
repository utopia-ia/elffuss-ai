# Read text: ocr.elffuss.com

The site reads the text of images, photos, scans and PDF files in the browser,
one file or whole folders, and gives it back per file and page, with the boxes
of every line. The module behind it is `@elffuss/ai/ocr` (API reference:
[api/ocr.md](api/ocr.md)).

## The model

PP-OCRv6 small by PaddlePaddle (Apache-2.0): a text detector and a text
recogniser, both used directly with ONNX Runtime Web, on WebGPU when the browser
offers a real adapter, else on WebAssembly. They are downloaded once, from their
original Hugging Face repositories at the revisions the registry pins, through
the Elffuss model store, and checked against their hashes. The settings of both
(thresholds, normalisation, input height, character list) are read from their
own `inference.yml`.

- **Languages:** Spanish, English and every other language of the model's
  Latin and Chinese character list: á é í ó ú ü ñ and their capitals, ¿, « », €,
  º, ª, ·. The list has no «¡», so the model cannot write it; the page says so.
- **Pipeline:** the detector's input keeps the shortest side at least 736 pixels
  and the longest under 4000, in multiples of 32; its probability map becomes
  boxes as PaddleOCR's DB post-processing does; each box is cropped upright with a
  perspective transform; each strip is read on its own (so a line reads the same
  whatever else is on the page) and decoded with greedy CTC. Lines the recogniser
  is less than 0.5 sure of are dropped.
- **Reading order:** boxes whose heights overlap by more than half the smaller
  one share a row; rows go top to bottom, boxes left to right; a row's boxes are
  joined with a space and the rows with a line break.

## What it reads

| Given | How |
|---|---|
| Files | the drop zone (click or drop), or pasted images (`pegado-1.png`) |
| A folder | «Choose a folder» (the directory picker where the browser has one, else a folder input), or a folder dropped on the zone; subfolders included |
| A photo | «Take a photo»: on a phone, the camera app hands the picture over as a file; the page never opens the camera itself |

Each file's type comes from its first bytes, never its name:

| Type | Read as |
|---|---|
| PNG, JPEG, GIF, WebP, BMP, AVIF | one page, decoded in the task's Worker with its EXIF orientation |
| TIFF | every page; decoded on the page: strips or tiles, 1 to 16 bits, bilevel, grey, palette, RGB, CMYK; none, PackBits, LZW, Deflate, CCITT fax (modified Huffman, Group 3, Group 4) and JPEG |
| PDF | every page, drawn at 200 dpi (the longest side at most 4000 pixels) by PDF.js; the text a digital PDF already carries is not used |
| HEIC | where the browser can decode it; elsewhere it is left out as an unsupported format |

Hidden and system files (names starting with a dot, `Thumbs.db`, `desktop.ini`,
`__MACOSX/`) are left out without a word: they only count in the summary and the
JSON document. An empty image file is an error (`decode-failed`); any other file
is left out as `unsupported-format`. The page asks before adding more than 2,000
files or 2 GB; a list holds at most 65,535 files (the ZIP has no ZIP64).

## How a folder is read

The list is made first, without decoding anything: paths, sizes, types, and a
summary («10 files: 5 images and 1 PDF; 4 are left out»). The primary button then
reads the files one after another, page by page, in natural path order. While a
page is read, the next one is decoded, so at most two decoded pages are alive at
once, and only text and boxes are kept: no images, no thumbnails.

- A file that cannot be opened or decoded is reported on its card and the
  reading goes on.
- A page that makes the reader fail is read once more, scaled down to 2560
  pixels; if it fails again it is reported as too large.
- With the backend chosen automatically, a failure on WebGPU is repeated once on
  WebAssembly, which is then used for the rest; the page says so.
- A failure of the model store or of the model stops the reading, keeping what
  was read; the primary button then reads the rest.
- «Pause» waits between pages; «Cancel» stops at once and keeps every file that
  was finished. Files added while reading are read too.

## Exports

Everything is made in the browser from the results and saved through a
temporary `blob:` link. Nothing in them says when or on what it ran.

- **One .txt per file** (`enero.png.txt`): UTF-8 without BOM, `\n` line breaks,
  each page's text followed by a line break, pages separated by a form feed
  (`\f`), as `pdftotext` does.
- **Markdown** (`texto.md`, `text.md` in English): a section per file, a
  subsection per page when there are several, the recognised text escaped so it
  is never read as markup, and a last section with the files that gave no text
  and why.
- **JSON** (`texto.json`, `text.json` in English), schema `elffuss-ocr/1`:

```json
{
  "schema": "elffuss-ocr/1",
  "tool": "ocr.elffuss.com",
  "build": "<build id>",
  "model": { "id": "ocr/pp-ocrv6-small", "det": { "repo": "…", "revision": "…" }, "rec": { "repo": "…", "revision": "…" }, "license": "Apache-2.0" },
  "device": "webgpu",
  "files": [
    { "path": "facturas/2026/enero.png", "type": "image/png", "size": 103579, "status": "ok", "device": "webgpu",
      "pages": [ { "page": 1, "width": 1600, "height": 1000, "text": "FACTURA Nº 2026/0147\n…",
                   "lines": [ { "text": "FACTURA Nº 2026/0147", "score": 0.99,
                                "box": { "xmin": 94, "ymin": 72, "xmax": 562, "ymax": 128 },
                                "polygon": [[94, 72], [562, 72], [562, 128], [94, 128]] } ] } ] },
    { "path": "notas/acta.pdf", "type": "application/pdf", "status": "ok", "pages": [ { "page": 1, "…": "…" }, { "page": 2, "error": "too-large" } ] },
    { "path": "leeme.txt", "type": null, "size": 67, "status": "skipped", "reason": "unsupported-format" },
    { "path": "fotos/rota.png", "type": "image/png", "size": 61, "status": "error", "error": "decode-failed" },
    { "path": "pendiente.png", "type": "image/png", "size": 5120, "status": "not-processed" },
    { "path": ".DS_Store", "status": "skipped", "reason": "hidden" }
  ],
  "summary": { "files": 6, "ok": 2, "skipped": 2, "errors": 1, "notProcessed": 1, "pages": 3 }
}
```

  Statuses: `ok`, `skipped` (`reason`: `hidden`, `unsupported-format`,
  `pdf-password`), `error` (`error`: `decode-failed`, `too-large`) and
  `not-processed` (cancelled or stopped before it). Boxes and polygons are in
  pixels of the page as read (for a PDF, its 200 dpi drawing); polygons go
  top-left, top-right, bottom-right, bottom-left. `fallback` appears when the
  reading moved from WebGPU to WebAssembly. The numbers above are an example.
- **ZIP** (`ocr-<folder>-<yyyymmdd-hhmm>.zip`): `texto/<path>.txt` for every file
  read, folders kept, then `texto.md` and `texto.json`. Stored (no
  compression), UTF-8 names, made by `sdk/core/zip.js`.

## Tests

`tests/unit/ocr-*.test.mjs` cover the pure parts (settings, dictionary,
detection, crop, recognition input, CTC, reading order, the TIFF decoder against
files written by libtiff, the queue, the list, the exports).
`tests/browser/specs/ocr.spec.mjs` drives the real page on WebGPU and on
WebAssembly with the fixtures of `tests/fixtures/ocr/`, made by
`scripts/make-fixtures.mjs`: the Spanish invoice must come out exactly, a poor
photo of it within 2 % of character errors, and a test folder (nested folders, a
two-page PDF, a two-page TIFF, broken, empty, hidden and unsupported files) with
the exact statuses, texts and exports of `carpeta.expected.*`.
