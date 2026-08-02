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

// flatten nested JSON to dot-path -> leaf map (only string/number leaves compared)
function flatten(obj, prefix, out) {
  out = out || {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

// placeholder tokens: {name} {{name}} %s %1$s {0} — normalized (whitespace stripped)
const PH_RE = /\{\{\s*[\w.]+\s*\}\}|\{\s*[\w.]+\s*\}|%\d*\$?[sdfeg]|\{\d+\}/g;
const placeholders = s => new Set((typeof s === 'string' ? s.match(PH_RE) || [] : []).map(x => x.replace(/\s+/g, '')));
const isICU = s => typeof s === 'string' && /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,/.test(s);
function icuCategories(s) {
  const cats = new Set(); const re = /(?:^|[\s{])(zero|one|two|few|many|other|=\d+)\s*\{/g; let m;
  while ((m = re.exec(s))) cats.add(m[1]);
  if (cats.has('=0')) cats.add('zero'); // explicit exact-match satisfies the named category
  if (cats.has('=1')) cats.add('one');
  if (cats.has('=2')) cats.add('two');
  return cats;
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
  const load = f => { try { return flatten(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (e) { return { __error: String(e.message) }; } };
  const baseMap = load(baseEntry.file);
  if (baseMap.__error) return { error: `base ${baseEntry.locale}: ${baseMap.__error}` };
  const results = [];
  for (const loc of locales) {
    if (loc.locale === baseEntry.locale) continue;
    const map = load(loc.file);
    const findings = [];
    if (map.__error) { findings.push({ rule: 'parse-error', key: '', msg: map.__error }); results.push({ ...loc, findings }); continue; }
    const req = requiredPlurals(loc.locale);
    for (const [key, bval] of Object.entries(baseMap)) {
      if (!(key in map)) { findings.push({ rule: 'missing-key', key, msg: `missing in ${loc.locale}` }); continue; }
      const val = map[key];
      if (val === '' || val == null) { findings.push({ rule: 'empty-value', key, msg: 'empty / untranslated' }); continue; }
      if (isICU(bval)) {
        const have = icuCategories(val);
        const missing = req.filter(c => !have.has(c));
        if (missing.length) findings.push({ rule: 'icu-plural-incomplete', key, msg: `${loc.locale} plural missing ${missing.join(', ')} (CLDR requires ${req.join('/')})` });
      } else {
        const bp = placeholders(bval), vp = placeholders(val);
        const dropped = [...bp].filter(x => !vp.has(x)), added = [...vp].filter(x => !bp.has(x));
        if (dropped.length || added.length) findings.push({ rule: 'placeholder-drift', key, msg: `placeholders differ${dropped.length ? ' — missing ' + dropped.join(',') : ''}${added.length ? ' — extra ' + added.join(',') : ''}` });
      }
    }
    for (const key of Object.keys(map)) if (!(key in baseMap)) findings.push({ rule: 'extra-key', key, msg: `not in base (${baseEntry.locale})` });
    results.push({ ...loc, findings });
  }
  return { base: baseEntry.locale, results };
}

module.exports = { checkCatalog, _internal: { flatten, placeholders, isICU, icuCategories, requiredPlurals } };
