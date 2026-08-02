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

// -- all-scripts propagation + segmentation smell -------------------------------
test('all-scripts: single-token non-Latin UI text (CJK/Thai/Arabic) is flagged', () => {
  const f = scanFindings(path.join(CORPUS, 'nonlatin-message', 'input.ts'));
  for (const s of ['保存', 'บันทึกแล้ว', 'احفظ'])
    assert.ok(f.some(x => x.rule === 'hardcoded-string' && x.from === s),
      `${s} is real UI text — the Latin-only single-token gate used to miss it`);
});

test('segmentation: Thai .split(" ") is flagged (spaceless script needs a segmenter)', () => {
  const f = scanFindings(path.join(CORPUS, 'seg-thai-split', 'input.ts'));
  assert.ok(f.some(x => x.rule === 'segmentation-smell' && x.from === ".split(' ')"),
    'split(" ") never finds a word boundary in Thai');
});

test('segmentation: CJK .length / .slice truncation is flagged', () => {
  const f = scanFindings(path.join(CORPUS, 'seg-cjk', 'input.ts'));
  assert.ok(f.some(x => x.rule === 'segmentation-smell' && x.from === '.length'),
    '.length counts UTF-16 code units, not graphemes');
  assert.ok(f.some(x => x.rule === 'segmentation-smell' && x.from === '.slice()'),
    '.slice() cuts through a CJK grapheme');
});

test('segmentation: word-break:break-all is flagged, but NOT when only named in a comment', () => {
  const f = scanFindings(path.join(CORPUS, 'seg-wordbreak', 'input.tsx'));
  const wb = f.filter(x => x.rule === 'segmentation-smell' && x.from === 'word-break: break-all');
  assert.strictEqual(wb.length, 1, 'flag the real declaration once; the comment naming it must not count');
  assert.strictEqual(wb[0].line, 3);
});

// -- severity model + hardening false-positive fixes (L1–L5) --------------------
// These read the FULL JSON (with `severity`), which the rule/line/from corpus
// loop above intentionally strips. Each fix proves BOTH halves: the reproduced
// false positive is now 0 / advice AND a genuine hardcoded UI string (usually a
// real Arabic-facing phrase) is still caught as a `warning`.
function scanFull(file) {
  const out = JSON.parse(runCli([file, '--json']) || '{}');
  return { summary: out.summary || {}, results: out.results || [] };
}
const CASE = name =>
  path.join(CORPUS, name, fs.readdirSync(path.join(CORPUS, name)).find(f => f.startsWith('input.')));

test('severity: every finding carries a severity and the summary tallies them', () => {
  const { summary, results } = scanFull(CASE('fp-brand-proper-noun'));
  assert.ok(results.length > 0);
  assert.ok(results.every(r => ['error', 'warning', 'advice'].includes(r.severity)),
    'each finding must carry error|warning|advice');
  const tally = { error: 0, warning: 0, advice: 0 };
  for (const r of results) tally[r.severity]++;
  assert.strictEqual(summary.error, tally.error);
  assert.strictEqual(summary.warning, tally.warning);
  assert.strictEqual(summary.advice, tally.advice);
  assert.strictEqual(summary.total, results.length);
});

test('L1: <code>/<pre>/<kbd>/<samp> content is NOT flagged; sibling UI text still warns', () => {
  const { results } = scanFull(CASE('fp-code-elements'));
  assert.ok(!results.some(r => /npm install|const x|Cmd Shift|not found/.test(r.from)),
    'code / shell / shortcut / sample output is not translatable');
  assert.ok(results.some(r => r.from === 'Install it now' && r.severity === 'warning'),
    'a genuine UI string is still a warning');
  assert.ok(results.some(r => r.from === 'مرحبا بمتجرنا' && r.severity === 'warning'),
    'a genuine Arabic-facing UI string is still a warning');
});

test('L2: a bare toLocale*() is advice (ok client-side), not a defect', () => {
  const { results } = scanFull(CASE('fp-tolocale-advice'));
  const tl = results.find(r => r.rule === 'unlocalized-format');
  assert.ok(tl && tl.severity === 'advice', 'no-arg toLocale* uses the host locale → advice');
  assert.ok(results.some(r => r.rule === 'hardcoded-string' && r.severity === 'warning'),
    'a genuine Arabic-facing UI string is still a warning');
});

test('L3: boolean/comparison .length is NOT flagged; a displayed count is advice', () => {
  const { results } = scanFull(CASE('fp-length-boolean'));
  const lens = results.filter(r => r.rule === 'segmentation-smell' && r.from === '.length');
  assert.strictEqual(lens.length, 1, 'only the displayed .length counts; if()/>0/===0 are emptiness checks');
  assert.strictEqual(lens[0].line, 7);
  assert.strictEqual(lens[0].severity, 'advice');
  assert.ok(results.some(r => r.rule === 'hardcoded-string' && r.severity === 'warning'),
    'a genuine Arabic-facing UI string is still a warning');
});

test('L4: a capitalized <Html> is NOT missing-html-lang; lowercase <html> still is', () => {
  const { results } = scanFull(CASE('fp-html-component'));
  assert.ok(!results.some(r => r.rule === 'missing-html-lang'),
    'a Next/styled <Html> component renders its own root — never flag it');
  assert.ok(results.some(r => r.from === 'حمل التطبيق الآن' && r.severity === 'warning'),
    'a genuine Arabic-facing UI string is still a warning');
  const html = scanFull(CASE('html-lang'));
  assert.ok(html.results.some(r => r.rule === 'missing-html-lang'),
    'the lowercase intrinsic <html> without lang still fires');
});

test('L5: a brand token is dropped, a lone proper noun is advice, a real phrase warns', () => {
  const { results } = scanFull(CASE('fp-brand-proper-noun'));
  assert.ok(!results.some(r => /Stripe|GitHub/.test(r.from)), 'brand names are not translatable copy');
  assert.ok(results.some(r => r.from === 'Morocco' && r.severity === 'advice'),
    'a lone Title-case proper noun is low-confidence → advice');
  assert.ok(results.some(r => r.from === 'سياسة الخصوصية' && r.severity === 'warning'),
    'a genuine Arabic-facing UI phrase is still a warning');
});

test('currency: Gulf/MENA ISO codes (KWD/QAR/BHD/OMR/EGP) are flagged; lowercase word "try" is NOT', () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lahja-cur-'));
  const file = path.join(dir, 'input.tsx');
  fs.writeFileSync(file,
    'export function P() {\n' +
    '  return <div>\n' +
    '    <span>Total: 250 KWD</span>\n' +
    '    <span>Deposit: 50 QAR</span>\n' +
    '    <span>Fee: 10 BHD</span>\n' +
    '    <span>Balance: 30 OMR</span>\n' +
    '    <span>Price: 199 EGP</span>\n' +
    // FP-safety: the English verb "try" after a digit (lowercase) is NOT the TRY lira
    '    <span>You have 3 try again later</span>\n' +
    '  </div>;\n' +
    '}\n');
  try {
    const f = scanFindings(file);
    const cur = f.filter(x => x.rule === 'hardcoded-currency').map(x => x.from);
    for (const c of ['250 KWD', '50 QAR', '10 BHD', '30 OMR', '199 EGP'])
      assert.ok(cur.includes(c), `${c} must be flagged as hardcoded currency`);
    assert.ok(!cur.some(x => /try/i.test(x)), 'lowercase "try" is the English verb, not the TRY lira → no false positive');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exit codes: default/--check gate on error (0); --strict fails on warnings; --report-only never fails', () => {
  const input = CASE('fp-brand-proper-noun'); // has warnings, zero errors
  const run = (extra) => {
    try { execFileSync(process.execPath, [CLI, input, ...extra], { encoding: 'utf8' }); return 0; }
    catch (e) { return e.status; }
  };
  assert.strictEqual(run([]), 0, 'default: no error → exit 0');
  assert.strictEqual(run(['--check']), 0, '--check gates on error → exit 0');
  assert.strictEqual(run(['--strict']), 1, '--strict also fails on warnings → exit 1');
  assert.strictEqual(run(['--report-only', '--strict']), 0, '--report-only always exits 0');
});
