'use strict';
/*
 * i18n catalog round-trip — the check real localization teams pay for.
 * Compares each locale's JSON catalog against a base locale for:
 *   missing-key · empty-value · placeholder-drift · icu-plural-incomplete · extra-key
 * ICU-plural completeness uses CLDR cardinal categories per language — the
 * Arabic-critical case (ar needs zero/one/two/few/many/other, not just one/other).
 * No dependencies; reads <locale>.json files from a directory.
 */
const fs = require('fs');
const path = require('path');

// CLDR cardinal plural categories required per language ('other' is universal).
const PLURALS = {
  en: ['one', 'other'], fr: ['one', 'many', 'other'], ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  de: ['one', 'other'], es: ['one', 'many', 'other'], hi: ['one', 'other'], it: ['one', 'many', 'other'],
  ja: ['other'], ko: ['other'], nl: ['one', 'other'], pt: ['one', 'many', 'other'], zh: ['other'],
  ru: ['one', 'few', 'many', 'other'], tr: ['one', 'other'], he: ['one', 'two', 'many', 'other'],
  fa: ['one', 'other'], ur: ['one', 'other'], pl: ['one', 'few', 'many', 'other'], cs: ['one', 'few', 'many', 'other'],
};
const langOf = loc => String(loc).toLowerCase().split(/[-_]/)[0];
const requiredPlurals = loc => PLURALS[langOf(loc)] || ['other'];

// flatten nested JSON to dot-path -> leaf map (only string/number leaves compared).
// The map has a NULL prototype so a top-level key named like an Object.prototype
// member (`toString`, `constructor`, `valueOf`, `hasOwnProperty`, `__proto__`)
// is compared correctly instead of always looking "present" via `key in map`.
function flatten(obj, prefix, out, depth) {
  out = out || Object.create(null);
  depth = depth || 0;
  if (depth > 100) { out[prefix || '(root)'] = '[too deeply nested]'; return out; } // guard vs stack overflow
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

// placeholder tokens: {name} {{name}} %s %1$s {0} — normalized (whitespace stripped)
const PH_RE = /\{\{\s*[\w.]+\s*\}\}|\{\s*[\w.]+\s*\}|%\d*\$?[sdfeg]|\{\d+\}/g;
const placeholders = s => new Set((typeof s === 'string' ? s.match(PH_RE) || [] : []).map(x => x.replace(/\s+/g, '')));
const isICU = s => typeof s === 'string' && /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,/.test(s);
// The ICU operator, so cardinal-plural completeness is applied ONLY to `plural`
// — a `select` (gender/enum) or `selectordinal` uses arbitrary/ordinal arms and
// must not be checked against CLDR cardinal categories.
const icuOp = s => { const m = typeof s === 'string' && s.match(/\{\s*\w+\s*,\s*(plural|select|selectordinal)\s*,/); return m ? m[1] : null; };
function icuCategories(s) {
  const cats = new Set(); const re = /(?:^|[\s{])(zero|one|two|few|many|other|=\d+)\s*\{/g; let m;
  while ((m = re.exec(s))) cats.add(m[1]);
  if (cats.has('=0')) cats.add('zero'); // explicit exact-match satisfies the named category
  if (cats.has('=1')) cats.add('one');
  if (cats.has('=2')) cats.add('two');
  return cats;
}

// Raw HTML entities that should be real characters — a common machine-translation
// artifact (a value ships "Terms &amp; conditions" or "caf&#233;" instead of the
// decoded glyph). Low-FP: we match only true &entity; tokens — numeric (&#233; /
// &#xE9;) or a curated set of named entities — so a legitimate lone ampersand
// ("Rock & Roll", "AT&T") is never flagged; those have no ';'-terminated entity.
const HTML_ENTITY_NAMES = [
  'amp', 'nbsp', 'quot', 'apos', 'lt', 'gt', 'copy', 'reg', 'trade', 'hellip',
  'mdash', 'ndash', 'lsquo', 'rsquo', 'ldquo', 'rdquo', 'laquo', 'raquo', 'deg',
  'times', 'divide', 'euro', 'pound', 'yen', 'cent', 'sect', 'para', 'middot',
  'bull', 'dagger', 'permil', 'prime', 'plusmn', 'frac12', 'frac14', 'frac34',
];
const HTML_ENTITY_RE = new RegExp(
  '&(?:#\\d+|#x[0-9a-fA-F]+|(?:' + HTML_ENTITY_NAMES.join('|') + '));', 'g');
function htmlEntities(s) {
  if (typeof s !== 'string') return [];
  const out = []; HTML_ENTITY_RE.lastIndex = 0; let m;
  while ((m = HTML_ENTITY_RE.exec(s))) out.push(m[0]);
  return out;
}

// Only files named like a locale (BCP-47-ish: en, ar, fr, pt-BR, zh-Hans, en-US),
// so package.json / tsconfig.json etc. are never mistaken for catalogs.
const LOCALE_RE = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,4})*$/;
function discover(dir) {
  let names; try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => n.endsWith('.json') && !n.startsWith('.'))
    .map(n => ({ locale: n.replace(/\.json$/, ''), file: path.join(dir, n) }))
    .filter(e => LOCALE_RE.test(e.locale));
}
const pickBase = (locales, base) =>
  (base && locales.find(l => l.locale === base)) ||
  locales.find(l => /^en([-_]|$)/i.test(l.locale)) || locales[0];

function checkCatalog(dir, opts) {
  opts = opts || {};
  const locales = discover(dir);
  if (locales.length < 2) return { error: `need >=2 <locale>.json files in ${dir} (a base + one to check); found ${locales.length}` };
  const baseEntry = pickBase(locales, opts.base);
  // Strip a leading UTF-8 BOM (common from VS Code / .NET / Excel exports) — the
  // file is valid JSON, only the BOM byte would trip JSON.parse. Returns a TYPED
  // result so a catalog that legitimately contains a top-level "__error" key
  // can't be mistaken for a parse failure.
  const load = f => {
    try { return { ok: true, map: flatten(JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''))) }; }
    catch (e) { return { ok: false, error: String(e.message) }; }
  };
  const baseRes = load(baseEntry.file);
  if (!baseRes.ok) return { error: `base ${baseEntry.locale}: ${baseRes.error}` };
  const baseMap = baseRes.map;
  const results = [];
  for (const loc of locales) {
    if (loc.locale === baseEntry.locale) continue;
    const res = load(loc.file);
    const findings = [];
    if (!res.ok) { findings.push({ rule: 'parse-error', key: '', msg: res.error }); results.push({ ...loc, findings }); continue; }
    const map = res.map;
    const req = requiredPlurals(loc.locale);
    for (const [key, bval] of Object.entries(baseMap)) {
      if (!(key in map)) { findings.push({ rule: 'missing-key', key, msg: `missing in ${loc.locale}` }); continue; }
      const val = map[key];
      if (val == null || (typeof val === 'string' && val.trim() === '')) { findings.push({ rule: 'empty-value', key, msg: 'empty / untranslated' }); continue; }
      if (icuOp(bval) === 'plural') {
        const have = icuCategories(val);
        const missing = req.filter(c => !have.has(c));
        if (missing.length) findings.push({ rule: 'icu-plural-incomplete', key, msg: `${loc.locale} plural missing ${missing.join(', ')} (CLDR requires ${req.join('/')})` });
      } else {
        // Non-ICU, `select`, and `selectordinal`: cardinal completeness does not
        // apply; a dropped/added inner {placeholder} is the real defect to catch.
        const bp = placeholders(bval), vp = placeholders(val);
        const dropped = [...bp].filter(x => !vp.has(x)), added = [...vp].filter(x => !bp.has(x));
        if (dropped.length || added.length) findings.push({ rule: 'placeholder-drift', key, msg: `placeholders differ${dropped.length ? ' — missing ' + dropped.join(',') : ''}${added.length ? ' — extra ' + added.join(',') : ''}` });
      }
      const ents = htmlEntities(val);
      if (ents.length) findings.push({ rule: 'html-entity-in-value', key, msg: `raw HTML entity ${[...new Set(ents)].join(', ')} — should be the decoded character (MT artifact)` });
    }
    // i18next suffix plurals: a translation carries CLDR-required siblings the
    // base lacks (Arabic needs foo_zero/two/few/many where English has only
    // foo_one/foo_other). Exempt those from extra-key.
    const basePluralStems = new Set();
    for (const k of Object.keys(baseMap)) { const sm = k.match(/^(.+)_(zero|one|two|few|many|other)$/); if (sm) basePluralStems.add(sm[1]); }
    for (const key of Object.keys(map)) if (!(key in baseMap)) {
      const sm = key.match(/^(.+)_(zero|one|two|few|many|other)$/);
      if (sm && basePluralStems.has(sm[1])) continue;
      findings.push({ rule: 'extra-key', key, msg: `not in base (${baseEntry.locale})` });
    }
    results.push({ ...loc, findings });
  }
  return { base: baseEntry.locale, results };
}

module.exports = { checkCatalog, _internal: { flatten, placeholders, isICU, icuOp, icuCategories, requiredPlurals, htmlEntities } };
