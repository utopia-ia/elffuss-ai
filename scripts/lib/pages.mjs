// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 UtopiaIA
//
// The HTML of each site: the page in Spanish (/) and English (/en/), the
// licence pages, 404 and robots.txt. Pure functions: the build and the tests
// call them with the same inputs.

import { render, esc, fill } from './template.mjs';
import { csp } from '../../deploy/headers.mjs';
import { siteUrl } from '../../deploy/sites.mjs';
import { pinnedUrl, repoPage } from '../../sdk/core/hub-url.js';
import { runtimeUrls, transformersDir } from '../../sdk/core/runtimes.js';
import { PINS, VENDOR_DIRS } from '../../sdk/core/runtime-pins.js';
import { ortVariantFor } from '../../sdk/core/device.js';

const LANGS = ['es', 'en'];
const mb = bytes => (bytes / 1e6 < 10 ? Math.round(bytes / 1e5) / 10 : Math.round(bytes / 1e6));
export const formatMB = (bytes, lang) => (lang === 'es' ? String(mb(bytes)).replace('.', ',') : String(mb(bytes)));

/** Paths of a site's pages for a channel (PRE lives under /beta/). */
export function pagePaths(channel) {
  const pre = channel === 'pre' ? 'beta/' : '';
  return {
    es: `${pre}index.html`, en: `${pre}en/index.html`,
    licEs: `${pre}licencias/index.html`, licEn: `${pre}en/licenses/index.html`,
    notFound: `${pre}404.html`,
    urlEs: `/${pre}`, urlEn: `/${pre}en/`, licUrlEs: `/${pre}licencias/`, licUrlEn: `/${pre}en/licenses/`,
  };
}

/** Source of the ONNX Runtime release the sites serve (its WebAssembly includes MPL-2.0 code). */
export const ORT_SOURCE = 'https://github.com/microsoft/onnxruntime/tree/v1.30.0';
/** The Eigen source that release builds with (cmake/deps.txt at v1.30.0): the MPL-2.0 part. */
export const EIGEN_SOURCE = 'https://github.com/eigen-mirror/eigen/archive/1d8b82b0740839c0de7f1242a3585e3390ff5f33.zip';

/** Models of a site, from the registry. */
export function siteModels(site, registry) {
  return (site.models || []).map(id => ({ id, ...registry.models[id] }));
}

/** The ONNX Runtime variant a site ships. */
export function siteOrtVariant(site, registry) {
  return ortVariantFor(siteModels(site, registry));
}

/** Third-party runtimes a site serves, for credits and licence pages. */
export function siteRuntimes(site, registry, manifest) {
  if (site.catalog) return [];
  const models = siteModels(site, registry);
  const variant = siteOrtVariant(site, registry);
  const ortId = VENDOR_DIRS.onnxruntimeWeb, tfId = VENDOR_DIRS.transformers, pdfId = VENDOR_DIRS.pdfjs;
  const out = [];
  if (models.some(m => m.runtime === 'transformers.js')) {
    // Its file bundles two libraries of its own authors, each with its licence.
    const bundled = Object.entries(manifest.packages[tfId].licenses).filter(([, l]) => l.bundled)
      .map(([p, l]) => ({ label: `${l.bundled.replace(/@(?=[^@]*$)/, ' ')} (${l.license})`, href: `/vendor/${transformersDir(variant)}/${p}` }));
    out.push({ key: 'transformers', name: 'Transformers.js', version: PINS.transformers, author: 'Hugging Face', license: manifest.packages[tfId].license,
      files: [{ label: 'licence', href: `/vendor/${transformersDir(variant)}/LICENSE` }, ...bundled], note: 'licenses.transformersNote' });
  }
  // The MPL-2.0 parts of ONNX Runtime's WebAssembly (Eigen): where their source is.
  out.push({ key: 'onnxruntimeWeb', name: 'ONNX Runtime Web', version: PINS.onnxruntimeWeb, author: 'Microsoft', license: manifest.packages[ortId].license,
    files: [{ label: 'licence', href: `/vendor/${ortId}/LICENSE.txt` }, { label: 'notices', href: `/vendor/${ortId}/ThirdPartyNotices.txt` },
      { label: 'source', href: ORT_SOURCE }, { label: 'eigen', href: EIGEN_SOURCE }], note: 'licenses.ortNote' });
  if (site.pdfjs) {
    out.push({ key: 'pdfjs', name: 'PDF.js', version: PINS.pdfjs, author: 'Mozilla', license: manifest.packages[pdfId].license,
      files: Object.keys(manifest.packages[pdfId].licenses).map(p => ({ label: p, href: `/vendor/${pdfId}/${p}` })) });
  }
  return out;
}

const runtimeList = (rts, lang) => {
  const items = rts.map(r => `${r.name} ${r.version} (${r.license})`);
  if (items.length <= 1) return items.join('');
  const and = lang === 'es' ? ' y ' : ' and ';
  return items.slice(0, -1).join(', ') + and + items.at(-1);
};

/** Sizes of a model's variants. */
function variantSizes(model) {
  return Object.values(model.devices).flat().map(v => v.bytes);
}

/** The static size text of a site's model line. */
export function sizeText(model, t, lang) {
  const sizes = variantSizes(model);
  const min = Math.min(...sizes), max = Math.max(...sizes);
  if (formatMB(min, lang) === formatMB(max, lang)) return fill(t['size.mb'], { n: formatMB(min, lang) });
  return fill(t['size.range'], { min: formatMB(min, lang), max: formatMB(max, lang) });
}

/** The model line of an app page, with its size in a span the shell refines. */
export function modelLine(model, t, lang) {
  const MARK = '\u0001SIZE\u0001';
  const line = esc(fill(t['model.line'], { model: model.base.name, author: model.base.author, license: model.base.license, size: MARK }));
  return line.replace(esc(MARK), `<span data-role="model-size">${esc(sizeText(model, t, lang))}</span>`) + ' ' + esc(t['privacy.download']);
}

/** The read-only storage panel: every file of every variant, with its size. */
export function storagePanel(model, t, lang) {
  const seen = new Map();
  for (const v of Object.values(model.devices).flat()) {
    for (const ref of v.files) {
      const i = ref.indexOf(':');
      const part = model.parts[ref.slice(0, i)], path = ref.slice(i + 1);
      const url = pinnedUrl(part.repo, part.revision, path);
      if (!seen.has(url)) seen.set(url, { url, path: Object.keys(model.parts).length > 1 ? `${ref.slice(0, i)}/${path}` : path, size: part.files[path].size });
    }
  }
  const items = [...seen.values()].map(f => `      <li data-url="${esc(f.url)}" data-size="${f.size}"><span>${esc(f.path)}</span> · <span>${esc(fill(t['size.mb'], { n: formatMB(f.size, lang) }))}</span> · <span data-role="storage-state">—</span></li>`);
  return `  <details class="storage" data-role="storage">
    <summary>${esc(t['storage.title'])}</summary>
    <p data-role="storage-summary"></p>
    <ul data-role="storage-files">
${items.join('\n')}
    </ul>
    <p class="muted">${esc(t['storage.note'])}</p>
  </details>`;
}

/** The footer of an app page. */
export function appFooter({ model, runtimes, t, lang, licUrl, catalogUrl }) {
  const lines = [`  <p>${esc(t['footer.local'])}</p>`];
  lines.push(`  <p>${esc(fill(t['footer.model'], { model: model.base.name, author: model.base.author, license: model.base.license }))}</p>`);
  const authors = [...new Set(Object.values(model.parts).map(p => `${p.author}|${p.license}`))];
  for (const a of authors) {
    const [author, license] = a.split('|');
    if (author !== model.base.author) lines.push(`  <p>${esc(fill(t['footer.conversion'], { author, license }))}</p>`);
  }
  lines.push(`  <p>${esc(fill(t['footer.runtimes'], { runtimes: runtimeList(runtimes, lang) }))}</p>`);
  lines.push(`  <p><a href="${esc(licUrl)}">${esc(t['footer.licenses'])}</a> · <a href="${esc(catalogUrl)}">${esc(t['footer.catalog'])}</a></p>`);
  return lines.join('\n');
}

/** Cards of the catalog: the tool sites, then the Elffuss apps. */
export function catalogCards({ sites, registry, t, lang, channel }) {
  const tools = sites.filter(s => !s.catalog).map(s => {
    const m = registry.models[s.models[0]];
    const url = siteUrl(s, channel) + (lang === 'en' ? 'en/' : '');
    const line = fill(t['card.model'], { model: m.base.name, author: m.base.author, license: m.base.license, size: sizeText(m, t, lang) });
    return `      <li><article class="card" data-site="${esc(s.site)}" data-model="${esc(s.models[0])}">
        <h3><a href="${esc(url)}">${esc(s.strings[lang]['catalog.name'])}</a></h3>
        <p>${esc(s.strings[lang]['catalog.line'])}</p>
        <p class="muted">${esc(line)}</p>
        <p data-role="stored" hidden>${esc(t['card.stored'])}</p>
      </article></li>`;
  });
  return tools.join('\n');
}

export function appCards({ apps, lang }) {
  return apps.map(a => `      <li><article class="card" data-app="${esc(a.id)}">
        <h3><a href="${esc(a.url)}">${esc(a.name[lang])}</a></h3>
        <p>${esc(a.line[lang])}</p>
      </article></li>`).join('\n');
}

/** Licence page of a site. */
export function licensesMain({ site, models, runtimes, t, base }) {
  const out = [`  <h1>${esc(t['licenses.title'])}</h1>`, `  <p>${esc(t['licenses.intro'])}</p>`];
  if (models.length) {
    out.push(`  <h2>${esc(t['licenses.models'])}</h2>`, '  <ul>');
    for (const m of models) {
      for (const p of Object.values(m.parts)) {
        const text = fill(t['licenses.modelItem'], { model: m.base.name, author: m.base.author, license: m.base.license, repo: p.repo, revision: p.revision.slice(0, 12), repoLicense: p.license });
        out.push(`    <li>${esc(text)} <a href="${esc(repoPage(p.repo, p.revision))}">${esc(p.repo)}</a> · <a href="${esc(m.base.url)}">${esc(m.base.name)}</a></li>`);
      }
    }
    out.push('  </ul>', `  <p>${esc(t['licenses.noWeights'])}</p>`);
  } else {
    out.push(`  <p>${esc(t['licenses.catalogModels'])}</p>`);
  }
  if (runtimes.length) {
    out.push(`  <h2>${esc(t['licenses.runtimes'])}</h2>`, '  <ul>');
    for (const r of runtimes) {
      const label = f => ({ licence: t['licenses.licence'], notices: t['licenses.notices'], source: t['licenses.source'], eigen: t['licenses.eigen'] })[f.label] || f.label;
      const links = r.files.map(f => `<a href="${esc(f.href)}">${esc(label(f))}</a>`).join(', ');
      out.push(`    <li>${esc(`${r.name} ${r.version} (${r.author}), ${r.license}`)}: ${links}.${r.note ? ' ' + esc(t[r.note]) : ''}</li>`);
    }
    out.push('  </ul>');
  }
  out.push(`  <h2>${esc(t['licenses.code'])}</h2>`);
  out.push(`  <p>${esc(t['licenses.siteCode'])} <a href="${esc(base)}LICENSES/Apache-2.0.txt">Apache-2.0</a> · <a href="${esc(base)}NOTICE.txt">NOTICE</a></p>`);
  out.push(`  <p>${esc(t['licenses.runonweb'])} <a href="${esc(base)}LICENSES/MIT-runonweb.txt">MIT</a></p>`);
  // Code of other projects that this site's own modules adapt (app.json `adapted`).
  for (const a of site.adapted || []) out.push(`  <p>${esc(t[a.key])} <a href="${esc(base)}${esc(a.file)}">${esc(a.license)}</a></p>`);
  return out.join('\n');
}

/**
 * Every page of a site.
 * @returns {Map<string, string>} path in the site's docroot → content
 */
export function sitePages({ site, sites, registry, manifest, strings, templates, channel, buildId, storeOrigin, apps }) {
  const paths = pagePaths(channel);
  const base = `/v/${buildId}/`;
  const tools = sites.find(s => s.catalog);
  const out = new Map();
  const models = siteModels(site, registry);
  const runtimes = siteRuntimes(site, registry, manifest);
  const cspMeta = channel === 'test' ? `<meta http-equiv="Content-Security-Policy" content="${esc(csp(site, { storeOrigin, meta: true }))}">\n` : '';
  const origin = siteUrl(site, channel === 'test' ? 'test' : 'pro');
  for (const lang of LANGS) {
    const t = strings[lang];
    const other = lang === 'es' ? 'en' : 'es';
    const catalogUrl = siteUrl(tools, channel) + (lang === 'en' ? 'en/' : '');
    const v = {
      lang, base, css: site.catalog ? 'catalog.css' : 'app.css',
      canonical: origin + (lang === 'en' ? 'en/' : ''),
      urlEs: origin, urlEn: origin + 'en/',
      home: lang === 'es' ? paths.urlEs : paths.urlEn,
      catalogUrl, otherLang: other, otherLangUrl: other === 'es' ? paths.urlEs : paths.urlEn,
      accept: site.accept || '',
    };
    const script = `<script type="module" src="${esc(base)}${site.catalog ? 'catalog.js' : 'app.js'}"></script>\n`;
    let main, footer;
    if (site.catalog) {
      main = render(templates.main, { t, v, html: { toolCards: catalogCards({ sites, registry, t, lang, channel }), appCards: appCards({ apps, lang }) } });
      footer = `  <p><a href="${esc(lang === 'es' ? paths.licUrlEs : paths.licUrlEn)}">${esc(t['footer.licenses'])}</a> · <a href="https://elffuss.com/">elffuss.com</a></p>`;
    } else {
      const model = models[0];
      main = render(templates.main, { t, v, html: { modelLine: modelLine(model, t, lang), storage: storagePanel(model, t, lang) } });
      footer = appFooter({ model, runtimes, t, lang, licUrl: lang === 'es' ? paths.licUrlEs : paths.licUrlEn, catalogUrl });
    }
    out.set(lang === 'es' ? paths.es : paths.en, render(templates.page, { t, v, html: { cspMeta, script, main, footer } }));
    const licT = { ...t, title: t['licenses.title'] };
    const licMain = licensesMain({ site, models, runtimes, t, base });
    const lv = { ...v, canonical: origin + (lang === 'es' ? 'licencias/' : 'en/licenses/'), home: v.home, otherLangUrl: other === 'es' ? paths.licUrlEs : paths.licUrlEn };
    out.set(lang === 'es' ? paths.licEs : paths.licEn, render(templates.page, { t: licT, v: lv, html: { cspMeta, script: '', main: licMain, footer: `  <p><a href="${esc(v.home)}">${esc(t.title)}</a> · <a href="${esc(catalogUrl)}">${esc(t['footer.catalog'])}</a></p>` } }));
  }
  const es = strings.es, en = strings.en;
  const nfMain = `  <h1>${esc(es['notfound.title'])} · <span lang="en">${esc(en['notfound.title'])}</span></h1>
  <p>${esc(es['notfound.text'])} <span lang="en">${esc(en['notfound.text'])}</span></p>
  <p><a href="${esc(paths.urlEs)}">${esc(es['notfound.home'])}</a> · <a href="${esc(paths.urlEn)}" lang="en">${esc(en['notfound.home'])}</a></p>`;
  out.set(paths.notFound, render(templates.page, {
    t: { ...es, title: es['notfound.title'] },
    v: { lang: 'es', base, css: site.catalog ? 'catalog.css' : 'app.css', canonical: origin, urlEs: origin, urlEn: origin + 'en/', home: paths.urlEs, catalogUrl: siteUrl(tools, channel), otherLang: 'en', otherLangUrl: paths.urlEn },
    html: { cspMeta, script: '', main: nfMain, footer: '' },
  }));
  if (channel !== 'pre') out.set('robots.txt', 'User-agent: *\nDisallow: /beta/\nDisallow: /v/\nDisallow: /vendor/\n');
  return out;
}

/** The config.js module of a site's build. */
export function configSource({ site, registry, channel, buildId, storeUrl, sites }) {
  const variant = site.catalog ? null : siteOrtVariant(site, registry);
  const cfg = {
    build: buildId,
    channel,
    site: site.site,
    model: site.models?.[0] || null,
    storeUrl,
    testHooks: channel === 'test',
    runtime: variant ? runtimeUrls({ variant, pdfjs: Boolean(site.pdfjs) }) : null,
    sites: Object.fromEntries(sites.map(s => [s.site, siteUrl(s, channel)])),
  };
  return `// GENERATED by scripts/build.mjs. Do not edit.\nexport default Object.freeze(${JSON.stringify(cfg, null, 2)});\n`;
}
