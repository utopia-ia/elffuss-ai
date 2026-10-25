# What a tool site must implement

The shared parts are done and tested: the model store client, the pinned
registry, the runtimes and their version checks, integrity, the Worker and its
restart after a failure, the CSP and Trusted Types, the page shell (texts in two
languages, storage panel, primary button label, progress, errors by code, the
WebGPU→WASM retry), the build, the headers and the vhosts, and the browser
harness. A site adds its task and its page on top, without changing them.

Each of the four sites (`cutout`, `ocr`, `detect`, `depth`) delivers the files
below, and only these, plus its own tests and fixtures. The only shared files it
touches are one line in `package.json` (its export) and, if it adapts runonweb
code, the file list of the runonweb paragraph in `NOTICE`.

## 1. The task module, `sdk/<task>/`

| File | What it is |
|---|---|
| `impl.js` | The implementation. Runs where the model runs (a Worker). Never fetches, never touches the DOM, never reads a file by itself |
| `worker.js` | Three lines: `import { serveTask } from '../core/worker-rpc.js'; import * as impl from './impl.js'; serveTask(impl);` |
| `index.js` | The public API: a class built on `Task` and its one-call form (`oneShot`), with JSDoc on every export (the API reference is generated from it) |
| `*.js` | Pure helpers with unit tests (decoders, post-processing, image maths) |
| `sizes.js` | Already generated from the registry; do not edit |

`impl.js` exports:

```js
export const task = 'depth';                      // the task name of the registry
export async function load(ctx) { … return state; }
export async function run(state, input, opts, ctx) { … return { value, transfer }; }
export async function dispose(state) { … }
```

What `ctx` (`TaskContext`, `sdk/core/task-runtime.js`) gives:

| Member | Use |
|---|---|
| `ctx.pipeline()` | The Transformers.js pipeline of the model and variant, fed only by the store at the pinned commit (remove-bg, depth, detect) |
| `ctx.transformers()` | The Transformers.js module (for `RawImage`, `Tensor`) |
| `ctx.ort()`, `ctx.session(ref, { providers })`, `ctx.bytes(ref)`, `ctx.text(ref)` | ONNX Runtime used directly, a session of one registry file, and the checked bytes or text of a file (ocr: `det:inference.onnx`, `det:inference.yml`, `rec:…`) |
| `ctx.device`, `ctx.dtype`, `ctx.variant`, `ctx.files`, `ctx.model`, `ctx.modelId` | What was chosen and what it needs |
| `ctx.report('running' \| 'done')` | Progress statuses during a run |
| `ctx.test` / `opts.test` | Test builds only, else `null`: honour `failRun` by feeding the model a tensor of an impossible shape **inside the runtime** (that is what leaves Transformers.js unusable and proves the Worker is replaced); `failLoad` by failing the load |

`input` of `run` is a `Blob`, an `ImageBitmap` or an `ImageData`; decode it with
`decodeImage` from `sdk/core/image-input.js` (type by first bytes, EXIF
orientation, `maxSide`). Errors are `AiError` with the codes of
`sdk/core/errors.js`; inputs fail with `decode-failed`, `unsupported-format` or
`too-large`, anything else with `run-failed`.

`index.js`, for example:

```js
import { Task, oneShot } from '../core/task.js';
/** Depth map of a photo. @extends Task */
export class Depth extends Task {
  /** @param {import('../core/task.js').TaskOptions} [options] */
  constructor(options) { super({ task: 'depth', workerUrl: new URL('./worker.js', import.meta.url), impl: () => import('./impl.js') }, options); }
}
/** Load, run once and dispose. */
export const depth = oneShot(Depth);
```

The value each `run` returns (design 6.1):

| Module | Class · one call | `run(input, opts)` returns |
|---|---|---|
| `@elffuss/ai/remove-bg` | `RemoveBg` · `removeBg()` | `{ png, width, height, alpha, device }`: PNG with transparency at the input's size, and the mask (`Uint8Array`, 0-255) |
| `@elffuss/ai/depth` | `Depth` · `depth()` | `{ png, width, height, depth, device }`: grey PNG (lighter is nearer) and the values (`Float32Array`, 0-1) |
| `@elffuss/ai/detect` | `Detect` · `detect()` | `{ objects: [{ label, score, box: { xmin, ymin, xmax, ymax } }], width, height, device }`; option `threshold` (0.5) |
| `@elffuss/ai/ocr` | `Ocr` · `ocr()` | `{ text, lines: [{ text, score, box, polygon }], width, height, device }` |

Then add `"./<task>": "./sdk/<task>/index.js"` to `exports` in `package.json`.

## 2. The site, `apps/<site>/`

| File | What it is |
|---|---|
| `app.js` | Replaces the scaffold. Builds on `createShell()` from `shared/shell.js` |
| `main.html` | Optional: the site's own `<main>` if `shared/main.html` is not enough (ocr: the folder button and its note; detect: the camera button, the threshold and `figure.stage`) |
| `app.css` | Layout only (see `shared/README.md`) |
| `strings.es.json`, `strings.en.json` | The texts; add keys freely, the two languages must have the same keys and placeholders |
| other `*.js` / `*.json` | The site's own modules and data (ocr: `folder.js`, `queue.js`, `pdf.js`, `export.js`; detect: `camera.js`, `labels.es.json`), copied into the build next to `app.js` |
| `app.json` | Set `"status": "ready"` when the site is done |

What the shell gives (`shared/shell.js`):

```js
const shell = await createShell();                       // texts, store, registry, storage panel, labels
const runner = shell.taskRunner(o => new Depth(o));      // the site's options, and one retry on WASM after a WebGPU failure with device 'auto'
shell.bindInput({ onFiles: (files, how) => …, paste: true });   // drop zone, picker, drag and drop, paste
shell.onPrimary(async ({ signal }) => {                  // busy state, errors by code, storage refreshed afterwards
  const { result, device, fallback } = await runner.run(file, { signal });
  const section = shell.showResult();                    // section.result; one article.card per item
  …; shell.download(result.png, 'name.png');             // secondary actions are button.ghost
});
shell.setReady(true); shell.setStatus(text); shell.showError(err); shell.t(key, vars); shell.deviceLabel(device);
```

Rules of the page: one `button.primary`; every other button `.ghost`; results in
`section.result` as `article.card`; states with the `hidden` attribute; no `style`
attribute or element, no inline script, no `innerHTML`; colours on a canvas read
from the CSS variables when painting; the device actually used shown with
`shell.deviceLabel()`; `?device=webgpu|wasm` is honoured by the shell; nothing is
downloaded before the primary button.

## 3. Tests the site must add and pass

Unit tests (`tests/unit/<task>*.test.mjs`, no network, no browser) for every pure
helper. A browser spec (`tests/browser/specs/<site>.spec.mjs`) that drives the real
page (input → primary button → result) in configurations A and B and validates
the **output** against references:

| Site | Inputs (in `tests/fixtures/<site>/`) | Passes when |
|---|---|---|
| ocr | `factura.png`, made by `scripts/make-fixtures.mjs` with the Archivo font; `foto-factura.jpg` (rotated, noisy, JPEG); `exclamacion.png`; `carpeta/` with clean files, a two-page PDF, an empty and a broken PNG, a HEIC header, a `.txt` and a `.DS_Store` | the Spanish text of the invoice is identical after normalising (NFC, single spaces, trimmed lines) in A and B; character error rate ≤ 2 % on the photo; the «¡» sample matches its reference and the page says the model lacks «¡»; the folder gives the exact statuses, paths, texts per file and page, ZIP listing, Markdown and JSON of `carpeta.expected.*` |
| cutout | `foto.jpg` (CC0 or public domain) with a clear subject; `mascara.json` (hand polygon); `golden-alpha.png` | IoU of the mask (alpha ≥ 128) against the polygon ≥ 0.85; against the reference IoU ≥ 0.98 and mean absolute alpha error ≤ 0.01, in A and B; the PNG has alpha and the input's size; `?device=webgpu` shows `device-unsupported` |
| depth | `foto.jpg` with something clearly near and far; `golden-depth.png` (16-bit, from WASM fp32); `regiones.json` | Pearson correlation with the reference ≥ 0.98 on WebGPU and ≥ 0.97 on WASM q8 (final values from what is measured, with a margin, never lowered without a note); the mean of «near» exceeds «far» by ≥ 0.1 |
| detect | `foto.jpg` with at least two COCO classes; `cajas.json` (hand boxes); a `.y4m` made by the harness from the photo for the camera | every hand box has a detection of its class with IoU ≥ 0.5 and score ≥ 0.5, and no detection ≥ 0.7 is unmatched; with the fake camera, three consecutive frames meet the same criterion; Stop leaves the tracks `ended`; only this site may use the camera |

Every fixture goes into `tests/fixtures/SOURCES.json` (sha256, CC0 / public domain /
own work, source and author, purpose; references also name model id, revision and
backend). None may be one of runonweb's samples (the deny-list catches it).

The harness already checks, for every site and both configurations, the clean
load, the markup and credits, the store being down, and (on `__test__/core.html`)
that the core loads and runs the model on the expected backend through the store,
with no download on reload, explicit backends, Worker replacement, version pins,
integrity, cancel and quota. A site's spec covers the same through its real page
where the UI is involved: the primary button's label before and after, the
result, the device it reports, and the fallback.

Run them:

```bash
node --test "tests/unit/*.test.mjs"
ELFFUSS_AI_CACHE=<cache dir> ELFFUSS_PLAYWRIGHT_DIR=<node_modules with playwright> node tests/browser/run.mjs --sites <site>
```

## 4. Not to be changed by a site

`sdk/core/`, `shared/` (except adding texts through the site's own strings),
`registry/` (the registry changes only through `registry/source.mjs` and its
generator, as a reviewed change of its own), `vendor/`, `deploy/`, `scripts/`
and the harness files other than the site's own spec. If a site needs something there,
it is a change of its own, with its own tests.
