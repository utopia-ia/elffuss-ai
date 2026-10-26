# Elffuss AI

Task modules for the browser, and the small sites built on them: remove the
background of a photo, read the text of images and PDFs, detect objects, and make
depth maps, with WebGPU or WebAssembly. Each site runs its model in your browser.
A site downloads its model, from its original Hugging Face repository at a pinned
revision (the first time; then it is kept in this browser), and the software that
runs it, from the site itself. The files you open never leave your device.

| Site | What it does | Model (licence) | Backends |
|---|---|---|---|
| [cutout.elffuss.com](https://cutout.elffuss.com/) | Remove the background, as a transparent PNG | BEN2 by PramaLLC (MIT) | WebAssembly |
| [ocr.elffuss.com](https://ocr.elffuss.com/) | Read the text of photos, scans and PDFs, even whole folders | PP-OCRv6 small by PaddlePaddle (Apache-2.0) | WebGPU or WebAssembly |
| [detect.elffuss.com](https://detect.elffuss.com/) | Detect up to 80 kinds of objects, also with the camera | RF-DETR Nano by Roboflow (Apache-2.0) | WebAssembly |
| [depth.elffuss.com](https://depth.elffuss.com/) | Work out what is near and what is far in a photo | Depth Anything V2 Small by depth-anything (Apache-2.0) | WebGPU or WebAssembly |
| [tools.elffuss.com](https://tools.elffuss.com/) | The catalog of every Elffuss tool | none | |

This repository is being built: the shared parts are done and tested, and the
four tasks land one by one (`docs/app-contract.md` says what each must do).

## Modules

<!-- modules:start -->
| Module | What it does | Site | Status |
|---|---|---|---|
| `@elffuss/ai/core` | Model store client, backend choice, pinned runtimes, registry, Worker host, errors, progress | every site | in use |
| `@elffuss/ai/remove-bg` | Remove the background of an image (transparent PNG) | [cutout.elffuss.com](https://cutout.elffuss.com/) | to be written (`./remove-bg/sizes` exists) |
| `@elffuss/ai/depth` | Depth map of a photo | [depth.elffuss.com](https://depth.elffuss.com/) | to be written (`./depth/sizes` exists) |
| `@elffuss/ai/detect` | Object detection, 80 COCO classes | [detect.elffuss.com](https://detect.elffuss.com/) | to be written (`./detect/sizes` exists) |
| `@elffuss/ai/ocr` | Text from images and PDFs | [ocr.elffuss.com](https://ocr.elffuss.com/) | to be written (`./ocr/sizes` exists) |
<!-- modules:end -->

Every module is plain ES modules, no build step, no dependencies: the runtimes
(Transformers.js, ONNX Runtime Web, PDF.js) are vendored at exact versions in
`vendor/` and served from each site's own origin. See `docs/` for the API
reference (generated from the JSDoc) and `docs/MODELS.md` for every model.

## How a site gets its model

1. The page embeds the Elffuss model store, a hidden iframe of
   `https://models.elffuss.com/`, and asks it which files of the model this
   browser already has (`has`). The primary button says what it will download.
2. On the click, the task's Worker asks the store for each file at its pinned
   URL and exact size (`get`). The store keeps it in its own storage, shared by
   the Elffuss sites, and downloads only what it lacks.
3. The SDK checks every file's hash against the registry (the first time in each browser),
   checks the runtime versions against the pins, and creates the session on
   the backend the registry allows for this browser. It never switches backend
   on its own; a site may retry once on WebAssembly and says so.
4. Runtime requests for model files (including the ones Transformers.js makes
   for the branch head) are answered from the pinned commit, so the page itself
   never talks to the Hub: its Content Security Policy only allows its own
   origin, the store's frame, and WebAssembly. Trusted Types are required.

The sites cannot empty the store, save copies into it or list it; the store only
accepts from them pinned files of the repositories in `registry/tasks.json`.

## Repository

| Path | What it holds |
|---|---|
| `sdk/core/` | The shared core: store client, backend choice, registry, pinned runtimes, Worker host, errors, progress, Trusted Types, ZIP writer |
| `sdk/<task>/` | One module per task (`sizes.js` is generated from the registry) |
| `registry/` | `source.mjs` (written by hand) and `tasks.json` (generated from the Hub API) |
| `vendor/` | The runtimes, byte for byte, pinned in `vendor/manifest.json` |
| `apps/<site>/` | Each tool site: descriptor, texts, page, script |
| `catalog/` | The `tools.elffuss.com` catalog |
| `shared/` | The page template, layout CSS, colour variables and the page shell |
| `deploy/` | Headers and CSP (one source), generated nginx vhosts, deploy scripts |
| `scripts/` | Build, registry, vendor, weights for tests, docs, publication sweep |
| `tests/unit/`, `tests/browser/` | Node tests; the browser harness and its specs |
| `docs/` | Generated reference, models, `llms.txt`, and the site contract |

## Develop and test

Node 22 or later. No `npm install`: there are no dependencies.

```bash
node --test "tests/unit/*.test.mjs"            # no network, no browser
node scripts/build.mjs all --channel test --dev --out <dir>   # build the sites locally
```

The browser tests serve each site from its own local origin with its real
headers, serve the model store page, answer Hugging Face from a local weight
cache, and run in Chrome twice: as a user has it (WebGPU, after checking for a
real adapter) and with WebGPU removed.

```bash
export ELFFUSS_AI_CACHE=<a directory outside the repo>          # weights, profiles, logs, test builds
export ELFFUSS_PLAYWRIGHT_DIR=<a node_modules that has playwright>
node scripts/fetch-weights.mjs                                   # once: every pinned file, checked
node scripts/make-broker-fixture.mjs --base <store page> --patch <tools patch>   # once: the store page
node tests/browser/run.mjs [--configs A,B] [--sites depth] [--only <text>]
```

WebGPU runs take the machine's coordination lock (`ELFFUSS_AI_LOCK`, or
`ELFFUSS_AI_LOCK=none`). The harness needs 5 GB free in the cache.

Maintenance, with the network:

```bash
node scripts/build-registry.mjs [--resolve | --check]   # registry from the Hub API
node scripts/vendor.mjs --check | --fetch | --pin <name@version>
node scripts/build-docs.mjs [--check]
node deploy/build-nginx.mjs [--check]
node scripts/sweep.mjs --release --git --dist dist      # publication sweep (ELFFUSS_SWEEP_PRIVATE)
```

## Licence

Apache-2.0, © 2026 UtopiaIA (`LICENSE`, `NOTICE`). Parts of the SDK are adapted
from runonweb.ai (MIT, Miguel Ángel Durán); each such file says which parts. The
vendored runtimes keep their own licences next to their files. Model weights are
not part of this repository and are not redistributed.

## En castellano

Módulos por tarea para el navegador y las webs pequeñas que los usan: quitar el
fondo de una foto, leer el texto de imágenes y PDF, detectar objetos y sacar
mapas de profundidad, con WebGPU o WebAssembly. Cada web ejecuta su modelo en tu
navegador. Cada web descarga su modelo, desde su repositorio original de Hugging
Face y fijado a una revisión (la primera vez; después se guarda en este
navegador), y el programa que lo ejecuta, desde la propia web. Los archivos que
abres no salen de tu equipo.

Cada web es un sitio estático con su propio dominio, su CSP y su certificado; el
catálogo de todas está en `tools.elffuss.com`. Los pesos pasan por el almacén de
modelos de Elffuss, que las herramientas solo pueden leer. El código es Apache-2.0
de UtopiaIA; parte del SDK procede de runonweb.ai (MIT).
