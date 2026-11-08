# Product

<!-- impeccable:product-schema 1 -->

<!-- Written from the repository and the owner's brief of 2026-11-08, without an interview: facts marked
(inferred) were not confirmed by the owner. -->

## Platform

web

## Users

People who want one job done on a picture, a document, a text or a sound, in their browser and without
uploading anything: remove a background, read the text of scans and PDFs (also whole folders), find objects,
get a depth map, make a picture, a video or a sound from a description or a photo. They arrive from
elffuss.com, from the catalog at tools.elffuss.com or straight at one tool's address. (inferred: mostly
non-specialists on a desktop browser; a share on phones.)

## Product Purpose

Small single-purpose tools that run the model on the visitor's own device (WebGPU, or WebAssembly where there
is no WebGPU). Each downloads its model once, from the original repository at a pinned revision, keeps it in
the browser and works offline after that. Success: the visitor finds the tool, gets the result with the fewest
clicks (one the first time, none after) and takes it away as a file.

## Positioning

Nothing leaves the visitor's device: the input, the result and the model run locally; the page says what it
downloads and how big it is before it downloads it.

## Operating Context

One page per tool on its own subdomain, in Spanish and English; the same shell (header with the Elffuss leaf,
storage panel, model line, credits) on all of them. The image, video and audio generators need WebGPU and
download large models (up to a few GB); the photo tools also run on WebAssembly.

## Capabilities and Constraints

- Models, registry and SDK are out of scope for the pages: a page changes how it looks, never what it runs.
- Content Security Policy: no inline styles or scripts, no external fonts or images; colours only through CSS
  variables; canvases read their colours from the variables.
- One primary button per page; its label names the action and the exact download size.
- Every text exists in both languages with the same placeholders.

## Brand Commitments

- The golden Elffuss leaf opens every header and links to elffuss.com (`shared/elffuss-mark.css`, unchanged).
- The tool sites and the elffuss.com chat share the slate ground and the brass primary buttons (7-nov-2026).
- A redesign changes the look, never what an app does or its words.

## Product Principles

1. The result is the page: what comes out gets the most room and the eye.
2. Say what will happen before it happens (download size, device support), plainly.
3. The fewest clicks: choosing the input is enough once the model is here.
4. Same controls, same places, on every tool.

## Accessibility & Inclusion

WCAG AA contrast, visible keyboard focus, reduced motion respected, 44 px touch targets on phones, usable at
390 px wide.
