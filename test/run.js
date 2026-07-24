'use strict';
/*
 * lahja regression suite (node --test).
 *
 * For every case under test/corpus/<case>/ it runs the real CLI with --json and
 * asserts the normalized findings deep-equal expected.findings.json. The corpus
 * encodes the audited, reproduced bugs as permanent guards:
 *   - adversarial-cross-line : a TS generic '>' must NEVER weld to a later '<'
 *   - string-literals        : const label='Add to cart' / alert('Saved') flagged
 *   - vue-bindings           : :placeholder="msg" binding must NOT be flagged
 *   - fp-html-in-string      : '<html>' inside a JS string is not "missing lang"
 *   - fp-keys-classnames     : keys/ids/classNames/imports never flagged
 *   - currency               : '$99' reported whole (not '$9'), no double count
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'lahja.js');
const CORPUS = path.join(__dirname, 'corpus');

function runCli(args) {
  try { return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }
  catch (e) { return (e.stdout || '') + ''; } // CLI exits 1 when findings remain
}

function scanFindings(file) {
  const out = JSON.parse(runCli([file, '--json']) || '{}');
  return (out.results || [])
    .map(f => ({ rule: f.rule, line: f.line, from: f.from }))
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule) || a.from.localeCompare(b.from));
}

const cases = fs.readdirSync(CORPUS)
  .filter(c => fs.statSync(path.join(CORPUS, c)).isDirectory())
  .sort();

assert.ok(cases.length >= 11, `expected the seeded corpus, found ${cases.length} cases`);

for (const name of cases) {
  const dir = path.join(CORPUS, name);
  const input = fs.readdirSync(dir).find(f => f.startsWith('input.'));
  const inputPath = path.join(dir, input);

  test(`${name}: scan findings match`, () => {
    const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.findings.json'), 'utf8'));
    assert.deepStrictEqual(scanFindings(inputPath), expected);
  });
}

// -- explicit adversarial guards (belt-and-suspenders over the corpus loop) -----
test('bug#1: cross-line TS-generic weld produces ZERO false positives', () => {
  const f = scanFindings(path.join(CORPUS, 'adversarial-cross-line', 'input.tsx'));
  assert.deepStrictEqual(f, [], 'a `>` from Array<string> must never weld to a later `<`');
});

test('bug#2: const label = "Add to cart" is flagged', () => {
  const f = scanFindings(path.join(CORPUS, 'string-literals', 'input.tsx'));
  assert.ok(f.some(x => x.rule === 'hardcoded-string' && x.from === 'Add to cart'));
  assert.ok(f.some(x => x.from === 'Saved'), 'alert("Saved") must be flagged');
});

test('bug#3: <html> inside a JS string is NOT missing-html-lang', () => {
  const f = scanFindings(path.join(CORPUS, 'fp-html-in-string', 'input.tsx'));
  assert.ok(!f.some(x => x.rule === 'missing-html-lang'));
});

test('bug#4: a Vue :placeholder="msg" binding is NOT flagged', () => {
  const f = scanFindings(path.join(CORPUS, 'vue-bindings', 'input.vue'));
  assert.ok(!f.some(x => x.from.includes('msg')), 'a bound attribute is dynamic, not UI text');
  assert.ok(f.some(x => x.from === 'placeholder="Search"'), 'a literal attr IS flagged');
});

test('bug#6: currency "$99" is reported whole, once', () => {
  const f = scanFindings(path.join(CORPUS, 'currency', 'input.tsx'));
  const cur = f.filter(x => x.rule === 'hardcoded-currency');
  assert.strictEqual(cur.length, 1);
  assert.strictEqual(cur[0].from, '$99', 'must be "$99", not the partial "$9"');
});
