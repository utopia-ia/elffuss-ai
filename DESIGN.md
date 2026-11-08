---
name: Elffuss tools
description: Single-purpose AI tools that run in the browser, on the Elffuss slate with brass for the one action.
colors:
  slate: "#303752"
  slate-panel: "#39415f"
  slate-raised: "#434c6e"
  slate-raised-hover: "#4c5679"
  slate-well: "#272c44"
  slate-bar: "#2a3049"
  line: "#4b5578"
  line-strong: "#6b759c"
  ink: "#f1eff7"
  ink-2: "#b9bed6"
  ink-3: "#9da4c4"
  brass: "#d9b27a"
  brass-hi: "#f0d2a4"
  brass-lo: "#d3a96e"
  brass-ink: "#e6c294"
  on-brass: "#1b1408"
  leaf: "#c8a06a"
  violet: "#8272ff"
  violet-ink: "#b3a8ff"
  teal: "#54dcc6"
  ok: "#5bd08a"
  warn: "#f0c060"
  err: "#ff8aa3"
typography:
  display:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.3
  small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.on-brass}"
    rounded: "{rounded.md}"
    padding: "11px 16px"
    height: "48px"
  button-primary-disabled:
    backgroundColor: "{colors.slate-raised}"
    textColor: "{colors.brass-ink}"
  button-ghost:
    backgroundColor: "{colors.slate-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "9px 18px"
    height: "44px"
  segment-selected:
    backgroundColor: "{colors.slate-raised}"
    textColor: "{colors.brass-ink}"
    rounded: "{rounded.sm}"
    height: "36px"
  input:
    backgroundColor: "{colors.slate-well}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "9px 12px"
    height: "44px"
  panel:
    backgroundColor: "{colors.slate-panel}"
    rounded: "{rounded.lg}"
    padding: "16px 18px"
  canvas:
    backgroundColor: "{colors.slate-well}"
    rounded: "{rounded.xl}"
---

# Design System: Elffuss tools

## Overview

**Creative North Star: "The desk and the canvas"**

Every tool page is a working surface. On the left, the desk: what goes in (a picture or a description), the
settings, and one brass button that says exactly what it will do and how much it downloads. On the right, the
canvas: a sunken well where the result appears, large, with the work in progress shown on it. The world is the
Elffuss slate shared with the elffuss.com chat: a medium-dark blue-grey, not black, lit from the top, with brass
reserved for the action and the current choice, violet and teal for data, progress and focus.

The tool bar under the header lists every tool in two groups (Create; Photos and documents) so a visitor can
always see the others and switch in one click; the catalog uses the same groups.

**Key Characteristics:**
- One brass button per page; everything else is quiet slate.
- The result gets the most room; the model line, sizes and credits are small and last.
- The same controls everywhere: segmented choices, sliders with their value and plain-language ends, expert
  settings folded under «Ajustes avanzados».
- Colours live in one place (`shared/elffuss-look.css`), derived from the eight variables of `tokens.css`.

## Colors

### Primary
- **Brass** (`#d9b27a`, gradient `#f0d2a4` → `#d3a96e`, dark text `#1b1408`): the primary button, the current
  tool in the bar, the selected segment's text and edge, links (`#e6c294` on slate).

### Secondary
- **Violet** (`#8272ff`, text `#b3a8ff`): data (the depth ramp, detection boxes), the photo tools' tiles.
- **Teal** (`#54dcc6`): keyboard focus and the start of the progress gradient.

### Neutral
- **Slate** `#303752` (ground), **panel** `#39415f`, **raised** `#434c6e` (controls), **well** `#272c44`
  (inputs, canvas), **bar** `#2a3049` (tool bar, header); lines `#4b5578` and `#6b759c` (control edges, 3:1 on
  the well). Ink `#f1eff7`, secondary `#b9bed6`, placeholder `#9da4c4` (on the well only).

### Named Rules
**The One Brass Rule.** Brass fills exactly one button per page, the primary action. A selected choice gets a
brass edge and brass text on raised slate, never a brass fill.

**The Leaf Rule.** The Elffuss leaf keeps its own brass (`#c8a06a`) and its sheet is never edited here.

## Typography

**Display Font:** Iowan Old Style (with Palatino, Georgia)
**Body Font:** the system sans

The serif names things (the brand, page titles, section and panel titles, catalog card names). Everything that is
operated (labels, buttons, values, hints) is the system sans; numbers are tabular.

### Hierarchy
- **Display** (700, 1.875rem, 1.5rem on a phone): the page's `h1`.
- **Heading** (700, 1.25rem): section titles, the settings panel's legend (1.125rem).
- **Body** (400, 1rem, 1.55): intros, text.
- **Label** (600, 0.875rem): field labels, buttons in segments, the tool bar.
- **Small** (400, 0.8125rem): hints, slider ends, the model line, credits.

## Layout

The page is `.intro` (title and one line), then `.studio`: one column on a phone (desk first), two from 60rem
(desk `minmax(20rem, 25rem)`, canvas the rest, 2rem apart). History and storage follow at full width. Spacing
steps: 4, 8, 12, 16, 24, 32 px; fields 20 px apart inside a panel; more space above a section title than below.
`main` is at most 80rem wide with 24 px gutters (16 px on a phone).

## Elevation & Depth

Depth is mostly tonal: the well sits below the slate, the panel and controls above it. Shadows are dark and
offset, never coloured glows.

### Shadow Vocabulary
- `--shadow-1`: `0 1px 2px` dark, for controls.
- `--shadow-2`: `0 10px 24px -14px` dark plus a 1 px contact shadow, for cards.
- `--shadow-brass`: a dark offset shadow and a light inner top edge on the primary button.

## Shapes

Radii 8 (controls), 12 (buttons, segments' track), 16 (panels, cards, drop zone), 20 (the canvas), pill (chips).
Dashed borders mean "something can be dropped here or will appear here" (drop zone, empty canvas, image frame).

## Components

### Buttons
Primary: brass gradient, 48 px tall, full width of the desk on a phone; disabled shows its label in brass ink on
a faint brass tint so the download size stays legible. Ghost: raised slate with a line, 44 px.

### Segmented control and chips
A well track with buttons (or radios in labels); the chosen one raised with a brass edge. Many or long choices
(`data-segmented="wrap"`) become separate pill chips. Built on the page's own `select` by `shared/controls.js`.

### Inputs / Fields
Well background, `#6b759c` edge, teal edge and 3 px teal halo on focus. Selects draw their chevron with two
gradients. A field is label (and its live value in brass ink), control, then a small hint or the two ends.

### Navigation
Header: the leaf, the site's name in the serif, small sans links. Tool bar: icon and short name per tool, two
groups split by a line, the current one on a brass tint with a brass edge; it scrolls sideways on a phone.

### The canvas (signature)
A sunken well with a dashed edge when empty (the tool's icon and where the result will appear; it also takes a
dropped file); holds the preview and the result cards. While the model works (`html[data-busy]`), a slow
teal-violet sweep crosses what is on it; the image frame also fills a progress line along its bottom.

## Do's and Don'ts

### Do:
- **Do** keep one brass button per page and say the download size in it.
- **Do** put a new setting in the panel as a segmented control, a slider with value and ends, or under
  «Ajustes avanzados» if only experts need it.
- **Do** add a new tool to `scripts/lib/tools-nav.mjs` (group, icon) and give it `tool.short` in both languages.

### Don't:
- **Don't** write colours outside the tokens of `shared/elffuss-look.css` (layout sheets may use only the eight
  variables).
- **Don't** use coloured glows, gradient text or animated backgrounds: they compete with the models running in the page.
- **Don't** hide a field a script fills or focuses without calling `reveal()` first.
