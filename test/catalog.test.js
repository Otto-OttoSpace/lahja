'use strict';
/*
 * lahja --catalog (i18n catalog round-trip) regression suite.
 * Runs the real CLI over temp locale files and asserts each defect class is
 * caught — including the Arabic-critical ICU-plural completeness (CLDR).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'lahja.js');
const setup = files => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lahja-cat-'));
  for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(d, name), JSON.stringify(obj));
  return d;
};
const runJson = (dir, extra = []) => {
  // --catalog exits 1 when issues are found; execFileSync throws on non-zero
  // exit but still captures stdout (the JSON) on the error object.
  try { return JSON.parse(execFileSync(process.execPath, [CLI, dir, '--catalog', '--json', ...extra], { encoding: 'utf8' })); }
  catch (e) { return JSON.parse(e.stdout); }
};
const rulesFor = (res, locale) => new Set(res.results.find(x => x.locale === locale).findings.map(f => f.rule));

test('catalog: catches missing-key, empty-value, placeholder-drift, Arabic ICU-plural gap', () => {
  const d = setup({
    'en.json': { greeting: 'Hello {name}', items: '{count, plural, one {# item} other {# items}}', save: 'Save', note: 'A note' },
    'ar.json': { greeting: 'مرحبا', items: '{count, plural, one {# عنصر} other {# عناصر}}', save: '' },
    'fr.json': { greeting: 'Bonjour {name}', items: '{count, plural, one {# él} other {# éls}}', save: 'Enr', note: 'Une note', bonus: 'x' },
  });
  try {
    const res = runJson(d);
    assert.strictEqual(res.base, 'en');
    const ar = rulesFor(res, 'ar');
    for (const r of ['placeholder-drift', 'icu-plural-incomplete', 'empty-value', 'missing-key']) assert.ok(ar.has(r), `ar should flag ${r}`);
    const fr = rulesFor(res, 'fr');
    assert.ok(fr.has('icu-plural-incomplete'), 'fr should flag missing plural category (many)');
    assert.ok(fr.has('extra-key'), 'fr should flag extra key');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: exits 0 (clean) when locales are complete', () => {
  const d = setup({ 'en.json': { a: 'A', b: 'Hi {x}' }, 'de.json': { a: 'Ä', b: 'Hallo {x}' } });
  try {
    execFileSync(process.execPath, [CLI, d, '--catalog'], { encoding: 'utf8' }); // throws on non-zero exit
    assert.ok(true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: --base overrides the base locale', () => {
  const d = setup({ 'en.json': { a: 'A' }, 'ar.json': { a: 'ا', b: 'ب' } });
  try {
    const res = runJson(d, ['--base', 'ar']);
    assert.strictEqual(res.base, 'ar');
    assert.ok(rulesFor(res, 'en').has('missing-key'), 'en should be missing b vs ar base');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: html-entity-in-value flags &amp;/&#233;/&nbsp;; a lone "&" (Rock & Roll) is safe', () => {
  const d = setup({
    'en.json': { terms: 'Terms and conditions', cafe: 'Cafe', spaced: 'Buy now', band: 'Rock and Roll' },
    'fr.json': {
      terms: 'Conditions &amp; usage',   // raw named entity — MT artifact
      cafe: 'Caf&#233;',                  // raw numeric entity
      spaced: 'Achetez&nbsp;maintenant',  // raw &nbsp;
      band: 'Rock & Roll',                // legitimate lone ampersand — must NOT flag
    },
  });
  try {
    const res = runJson(d);
    const fr = res.results.find(x => x.locale === 'fr');
    const ent = fr.findings.filter(f => f.rule === 'html-entity-in-value');
    const keys = new Set(ent.map(f => f.key));
    for (const k of ['terms', 'cafe', 'spaced']) assert.ok(keys.has(k), `${k} should flag html-entity-in-value`);
    assert.ok(!keys.has('band'), 'a legitimate lone "&" must not be flagged');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: ignores non-locale JSON (package.json etc.)', () => {
  const d = setup({ 'en.json': { a: 'A' }, 'ar.json': { a: 'ا' }, 'package.json': { name: 'x' } });
  try {
    const res = runJson(d);
    assert.ok(!res.results.some(r => r.locale === 'package'), 'package.json must not be treated as a locale');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── regression: ICU select must NOT be checked as a cardinal plural ──────────
test('catalog: valid select/gender is not reported as an incomplete plural', () => {
  const d = setup({
    'en.json': { who: '{gender, select, male {He replied} female {She replied} other {They replied}}' },
    'ar.json': { who: '{gender, select, male {هو رد} female {هي ردت} other {هم ردوا}}' },
  });
  try {
    const ar = rulesFor(runJson(d), 'ar');
    assert.ok(!ar.has('icu-plural-incomplete'), 'a select must not demand cardinal plural categories');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: a genuine plural gap is still flagged (select fix did not over-relax)', () => {
  const d = setup({
    'en.json': { cart: '{count, plural, one {# item} other {# items}}' },
    'ar.json': { cart: '{count, plural, other {# عنصر}}' },
  });
  try {
    assert.ok(rulesFor(runJson(d), 'ar').has('icu-plural-incomplete'), 'ar still needs zero/one/two/few/many');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: top-level keys named like Object.prototype members are diffed', () => {
  const d = setup({
    'en.json': { toString: 'Convert', constructor: 'Builder', greeting: 'Hi' },
    'ar.json': { greeting: 'مرحبا' },
  });
  try {
    const ar = runJson(d).results.find(x => x.locale === 'ar').findings.map(f => f.key);
    assert.ok(ar.includes('toString') && ar.includes('constructor'), 'dropped prototype-named keys must be reported');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: a whitespace-only translation is empty-value', () => {
  const d = setup({ 'en.json': { save: 'Save', ok: 'OK' }, 'ar.json': { save: '   ', ok: '\t' } });
  try {
    assert.ok(rulesFor(runJson(d), 'ar').has('empty-value'), 'blank/whitespace value is untranslated');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: i18next CLDR plural siblings are not extra-key', () => {
  const d = setup({
    'en.json': { item_one: '1 item', item_other: '{{count}} items' },
    'ar.json': { item_zero: '0', item_one: '1', item_two: '2', item_few: '3', item_many: '4', item_other: '{{count}}' },
  });
  try {
    assert.ok(!rulesFor(runJson(d), 'ar').has('extra-key'), 'ar plural forms EN lacks are required, not extra');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: a UTF-8 BOM on the base file does not abort the run', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lahja-bom-'));
  fs.writeFileSync(path.join(d, 'en.json'), '﻿' + JSON.stringify({ hello: 'Hello' }));
  fs.writeFileSync(path.join(d, 'ar.json'), JSON.stringify({ hello: 'مرحبا' }));
  try {
    const res = runJson(d);
    assert.ok(!res.error, 'BOM must be stripped, not treated as a parse error');
    assert.strictEqual(res.base, 'en');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── regression: a legit "__error" catalog key must not abort the run ─────────
test('catalog: a real "__error" key is diffed, not treated as a parse failure', () => {
  const d = setup({
    'en.json': { __error: 'Something went wrong', ok: 'OK' },
    'ar.json': { __error: 'خطأ', ok: 'موافق' },
  });
  try {
    const res = runJson(d);
    assert.ok(!res.error, 'a data-space __error key must not abort the check');
    assert.strictEqual(res.base, 'en');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: --json emits a JSON error envelope on a real parse failure', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lahja-perr-'));
  fs.writeFileSync(path.join(d, 'en.json'), 'not json{');
  fs.writeFileSync(path.join(d, 'ar.json'), JSON.stringify({ a: '1' }));
  try {
    // runJson recovers stdout on the non-zero exit — it must still be valid JSON.
    const res = runJson(d);
    assert.ok(res.error && /base en/.test(res.error), 'error is reported inside the JSON envelope');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── catalog FN extensions ────────────────────────────────────────────────────
test('catalog: flags type mismatches (string→number/bool, non-empty array→empty)', () => {
  const d = setup({
    'en.json': { count: '5 apples', flag: 'Enabled', steps: ['First', 'Second'] },
    'ar.json': { count: 5, flag: true, steps: [] },
  });
  try {
    const ar = rulesFor(runJson(d), 'ar');
    assert.ok(ar.has('type-mismatch'), 'string→number/bool is a type mismatch');
    assert.ok(ar.has('empty-value'), 'a non-empty array translated as [] is empty');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: a plural arm that drops an inner {name} is placeholder-drift', () => {
  const d = setup({
    'en.json': { cart: '{count, plural, one {Hi {name}, # item} other {Hi {name}, # items}}' },
    'de.json': { cart: '{count, plural, one {# Artikel} other {# Artikel}}' },
  });
  try {
    assert.ok(rulesFor(runJson(d), 'de').has('placeholder-drift'), 'dropped {name} inside plural arms');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('catalog: recognizes $t()/%(name)s/<0>/hyphenated placeholder families', () => {
  const d = setup({
    'en.json': { nest: 'Welcome $t(appName)', py: 'Hi %(name)s', trans: 'Read <0>terms</0>', hyph: 'Order {order-id}' },
    'ar.json': { nest: 'مرحبا', py: 'مرحبا', trans: 'اقرأ', hyph: 'طلب' },
  });
  try {
    const keys = runJson(d).results.find(x => x.locale === 'ar').findings.filter(f => f.rule === 'placeholder-drift').map(f => f.key);
    for (const k of ['nest', 'py', 'trans', 'hyph']) assert.ok(keys.includes(k), `${k} placeholder drift detected`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
