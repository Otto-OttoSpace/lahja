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

// Duplicate keys within the SAME object: JSON.parse keeps only the LAST value, so
// a repeated key silently drops a translation — invisible to a value-level diff
// (the parsed object already lost the earlier one). Minimal string-aware scan of
// the RAW text: only a string sitting in an object's key slot (right after `{` or
// `,`, before its `:`) is a key, compared per nesting frame so the same name in
// two different objects is fine. Raw (undecoded) key text is compared, so an
// exotic pair like "ab" / "ab" is under-reported, never false-flagged.
function findDuplicateKeys(src) {
  const dups = [];
  const stack = []; // frames: { type:'object', seen:Set } | { type:'array' }
  let expectKey = false;
  let line = 1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (c === '\n') { line++; continue; }
    if (c === '{') { stack.push({ type: 'object', seen: new Set() }); expectKey = true; continue; }
    if (c === '[') { stack.push({ type: 'array' }); expectKey = false; continue; }
    if (c === '}' || c === ']') { stack.pop(); expectKey = false; continue; }
    if (c === ',') { const top = stack[stack.length - 1]; expectKey = !!(top && top.type === 'object'); continue; }
    if (c === ':') { expectKey = false; continue; }
    if (c === '"') {
      const startLine = line;
      let j = i + 1;
      for (; j < n; j++) {
        if (src[j] === '\\') { j++; continue; } // skip the escaped char (e.g. \")
        if (src[j] === '"') break;
        if (src[j] === '\n') line++;
      }
      const raw = src.slice(i + 1, j);
      i = j; // land on the closing quote; the loop's i++ steps past it
      const top = stack[stack.length - 1];
      if (top && top.type === 'object' && expectKey) {
        if (top.seen.has(raw)) dups.push({ key: raw, line: startLine });
        else top.seen.add(raw);
      }
      continue;
    }
  }
  return dups;
}

// placeholder tokens: {name} {{name}} %s %1$s {0} — normalized (whitespace stripped)
// Placeholder families: {{name}} · {name} · {order-id} (hyphenated) · %s/%1$s/%i/%x
// · %(name)s (python) · {0} · $t(nested) (i18next) · <0>…</0> (react-i18next).
const PH_RE = /\{\{\s*[\w.-]+\s*\}\}|\{\s*[\w.-]+\s*\}|%\([\w.]+\)[sdifgeuxX]|%\d*\$?[sdfegixX]|\{\d+\}|\$t\([^)]*\)|<\/?\d+>/g;
const placeholders = s => new Set((typeof s === 'string' ? s.match(PH_RE) || [] : []).map(x => x.replace(/\s+/g, '')));
// Occurrence counts (not just presence) — lets ICU drift require a placeholder to
// appear in MULTIPLE arms (a genuine cross-arm variable like `{name}` repeated in
// every plural case) before calling it dropped, so a one-arm literal isn't.
const placeholderCounts = s => {
  const m = Object.create(null);
  for (const t of (typeof s === 'string' ? s.match(PH_RE) || [] : [])) { const k = t.replace(/\s+/g, ''); m[k] = (m[k] || 0) + 1; }
  return m;
};
const typeName = v => Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
const isICU = s => typeof s === 'string' && /\{\s*\w+\s*,\s*(?:plural|select|selectordinal)\s*,/.test(s);
// The ICU operator, so cardinal-plural completeness is applied ONLY to `plural`
// — a `select` (gender/enum) or `selectordinal` uses arbitrary/ordinal arms and
// must not be checked against CLDR cardinal categories.
const icuOp = s => { const m = typeof s === 'string' && s.match(/\{\s*\w+\s*,\s*(plural|select|selectordinal)\s*,/); return m ? m[1] : null; };
function icuCategories(s) {
  // A category keyword can follow the `plural,` operator (`,one{`), a previous
  // arm's close (`}other{`), or whitespace/`{` — Mastodon and others write arms
  // WITHOUT spaces (`zero{}one{…}`), which the old `[\s{]`-only boundary missed,
  // producing false "missing one/other". (B2)
  const cats = new Set(); const re = /(?:^|[\s{},])(zero|one|two|few|many|other|=\d+)\s*\{/g; let m;
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
  if (opts.base && !locales.find(l => l.locale === opts.base)) {
    return { error: `base "${opts.base}" not found (have: ${locales.map(l => l.locale).join(', ')})` };
  }
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
  // Duplicate-key scan runs off the raw text (JSON.parse would have hidden the
  // dupes), for every locale including the base.
  const rawDups = Object.create(null);
  for (const loc of locales) {
    try { rawDups[loc.locale] = findDuplicateKeys(fs.readFileSync(loc.file, 'utf8').replace(/^﻿/, '')); }
    catch { rawDups[loc.locale] = []; }
  }
  const dupFindings = locale => (rawDups[locale] || []).map(d =>
    ({ rule: 'duplicate-key', key: d.key, msg: `duplicated at line ${d.line} — JSON keeps only the last value, silently dropping the earlier translation` }));
  const results = [];
  for (const loc of locales) {
    if (loc.locale === baseEntry.locale) continue;
    const res = load(loc.file);
    const findings = dupFindings(loc.locale);
    if (!res.ok) { results.push({ ...loc, findings: [{ rule: 'parse-error', key: '', msg: res.error }] }); continue; }
    const map = res.map;
    const req = requiredPlurals(loc.locale);
    for (const [key, bval] of Object.entries(baseMap)) {
      if (!(key in map)) { findings.push({ rule: 'missing-key', key, msg: `missing in ${loc.locale}` }); continue; }
      const val = map[key];
      if (val == null || (typeof val === 'string' && val.trim() === '') ||
        (Array.isArray(val) && val.length === 0 && Array.isArray(bval) && bval.length > 0)) {
        findings.push({ rule: 'empty-value', key, msg: 'empty / untranslated' }); continue;
      }
      // Type mismatch: a string translated as a number/boolean, or an array where
      // the base is a string (or vice-versa). Don't run string checks on these.
      if (typeof bval !== typeof val || Array.isArray(bval) !== Array.isArray(val)) {
        findings.push({ rule: 'type-mismatch', key, msg: `type differs — base is ${typeName(bval)}, ${loc.locale} is ${typeName(val)}` });
        continue;
      }
      if (icuOp(bval) === 'plural') {
        const have = icuCategories(val);
        const missing = req.filter(c => !have.has(c));
        if (missing.length) findings.push({ rule: 'icu-plural-incomplete', key, msg: `${loc.locale} plural missing ${missing.join(', ')} (CLDR requires ${req.join('/')})` });
      }
      // Placeholder drift. For a PLAIN string, any placeholder present in the
      // base but missing from the translation (dropped) or vice-versa (added) is
      // a bug. For an ICU plural/select the arms differ by language (Arabic has
      // six plural arms to English's two), so both a one-arm literal (`{year}`)
      // and an arm-restructure (`#` ⇄ `{attachmentCount}`) read as spurious
      // drops/adds. So on ICU we flag a DROP only when the placeholder is a
      // genuine cross-arm variable — present in ≥2 base arms yet absent from the
      // whole translation — and never flag adds. Plain strings are unchanged. (B2)
      const bp = placeholders(bval), vp = placeholders(val);
      let dropped, added;
      if (isICU(bval)) {
        const bc = placeholderCounts(bval);
        dropped = Object.keys(bc).filter(x => bc[x] >= 2 && !vp.has(x));
        added = [];
      } else {
        dropped = [...bp].filter(x => !vp.has(x));
        added = [...vp].filter(x => !bp.has(x));
      }
      if (dropped.length || added.length) findings.push({ rule: 'placeholder-drift', key, msg: `placeholders differ${dropped.length ? ' — missing ' + dropped.join(',') : ''}${added.length ? ' — extra ' + added.join(',') : ''}` });
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
  // Surface duplicate keys in the base file itself (it isn't diffed against
  // anything, so it only enters `results` when it has its own defect).
  const baseDups = dupFindings(baseEntry.locale);
  if (baseDups.length) results.unshift({ ...baseEntry, findings: baseDups });
  return { base: baseEntry.locale, results };
}

module.exports = { checkCatalog, _internal: { flatten, placeholders, isICU, icuOp, icuCategories, requiredPlurals, htmlEntities, findDuplicateKeys } };
