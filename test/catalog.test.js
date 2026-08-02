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

test('catalog: ignores non-locale JSON (package.json etc.)', () => {
  const d = setup({ 'en.json': { a: 'A' }, 'ar.json': { a: 'ا' }, 'package.json': { name: 'x' } });
  try {
    const res = runJson(d);
    assert.ok(!res.results.some(r => r.locale === 'package'), 'package.json must not be treated as a locale');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
