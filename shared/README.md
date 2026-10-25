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
   variables). It may redefine the variables. Empty on purpose until the UI session writes it.

No `style` attributes, no `<style>` elements and no inline scripts anywhere: the
Content Security Policy refuses them, and the tests check the built pages.

## The class contract

| Selector | What it is |
|---|---|
| `header` with `a.brand` and `nav` | site name; links to the catalog, elffuss.com and the other language |
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

States are the `hidden` attribute; progress is a `<progress>` element. Data hooks
(`data-role`, `data-action`, `data-input`, `data-site`) are for scripts, not for styling.

Canvas drawings (the boxes of detect) read their colours from the variables when
they paint, so JavaScript never has a colour written in it either.
