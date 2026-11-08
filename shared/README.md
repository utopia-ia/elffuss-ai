# Shared markup and styles of the tool sites

Every site (`cutout`, `ocr`, `detect`, `depth` and the `tools` catalog) is built from
`shared/page.html` and its own `main.html`. The markup is minimal and semantic so that
one stylesheet, `shared/elffuss-look.css`, can give all of them their look.

## Stylesheets, in this order

1. `tokens.css`: fallback values of the eight colour variables, the only colours
   written anywhere: `--bg`, `--bg2`, `--bg3`, `--line`, `--fg`, `--muted`, `--accent`, `--accent2`.
2. `layout.css`: boxes, grids, spacing and sizes only.
3. the site's `app.css` (or `catalog.css`): layout only.
4. `elffuss-look.css`: the look (borders, radii, shadows, type, colours through the
   variables). It redefines the eight variables and derives the whole token set from them
   (surfaces, ink, brass, violet, teal, states, radii, type scale, shadows, motion), with the
   measured contrast in its header comment: change colours there, and only there.
5. `elffuss-mark.css`: the Elffuss mark, the same file on every Elffuss site (approved
   in f3d3d69; never edited here). Its leaf stays the hub's brass: `elffuss-look.css`
   sets `--accent` on `header .elffuss-mark`; its size in the header is in `layout.css`.

No `style` attributes, no `<style>` elements and no inline scripts anywhere: the
Content Security Policy refuses them, and the tests check the built pages.

## The class contract

| Selector | What it is |
|---|---|
| `header` with `.brand-row` and `nav` | `.brand-row`: the Elffuss mark (`a.elffuss-mark`, styled only by `elffuss-mark.css`, a link to elffuss.com), a `.brand-sep` dot and `a.brand`, the site name; `nav`: links to the catalog, elffuss.com and the other language |
| `main` | the page content |
| `button.primary` | the one main action of a site (exactly one per app; the catalog has none) |
| `button.ghost` | every other action |
| `label.drop` | the drop zone; its file `input` is inside, hidden with `.visually-hidden` |
| `section.result` | where results appear (hidden until there is one) |
| `article.card` | one item: a file's result, or a tool in the catalog (`ul.cards > li > article.card`) |
| `figure.stage` | an image with an overlay `canvas.overlay` on top (detect) |
| `p.status` | live status line (`role="status"`) |
| `.muted` | secondary text |
| `.visually-hidden` | hidden but reachable by keyboard and screen readers |
| `details.storage` | the read-only storage panel: which model files this browser has |
| `.actions` | a row of buttons |
| `nav.toolbar` | the bar of every tool under an app's header (built from `scripts/lib/tools-nav.mjs`: groups, order, icons; each site's `tool.short`), the page's own with `aria-current="page"`; the catalog has none |
| `.intro` | the page's `h1` and its one-line purpose |
| `.studio` > `.desk` + `.canvas` | the desk (the input, the settings, the action) beside the canvas (the preview and the result); one column on a phone, the desk first |
| `.placeholder` | the empty canvas: the tool's icon and where the result will appear; `data-drop` makes it a drop target too (shell `bindInput`) |
| `fieldset.options` | the settings of a page, each in a `.field` (`.field-head` with its `label` and an `output`, the control, a `p.hint` or `p.ends`) |
| `details.advanced` | the expert settings, folded (seed, steps…); `reveal(el)` from `shared/controls.js` opens it before a script focuses one |
| `.segmented` | a choice among a few: radios inside `label`s, or a `select[data-segmented]` that `shared/controls.js` turns into buttons (`data-segmented="wrap"`: chips that wrap) |
| `output[data-range]` | the live value of the range input it is `for` (`data-suffix`), kept by `shared/controls.js` |
| `.go` | the primary button, the progress, the status and the model line, small |
| `aside.install` | the "Install … as an app" box `shared/install.js` puts at the top of `main` (`.install-title`, `.install-why`, `.install-how`) |

States are the `hidden` attribute; progress is a `<progress>` element; while the primary action runs the
shell sets `html[data-busy]` (the canvas shows a slow sweep), and a zone with a file dragged over it has `data-over`. Data hooks
(`data-role`, `data-action`, `data-input`, `data-site`) are for scripts, not for styling.

Canvas drawings (the boxes of detect) read their colours from the variables when
they paint, so JavaScript never has a colour written in it either.

## Installing a site as an app

Every page links a web app manifest of its language (`/v/<build>/manifest.<lang>.json`, built by
`scripts/lib/pages.mjs`; PRE has its own `manifest.beta.<lang>.json`) and the icons in `shared/icons/`
(the PNGs are rendered from the two SVGs next to them: the Elffuss leaf on the `--bg` ground; the
maskable one keeps the leaf inside the central safe circle). The app pages carry a hidden
`a[data-action="install"]` in the header's nav; `shared/install.js` shows it while the site is not
running installed, opens the browser's install dialog when there is one or the box with the steps,
offers the box by itself only on a phone ("Not now" silences it for the tab), and asks for
persistent storage once installed. Its texts are the `install.*` strings.
