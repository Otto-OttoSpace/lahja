'use strict';
/*
 * lahja core — AST-verified detection of user-facing strings AI code tools
 * hardcode instead of translating.
 *
 * "Zero mistakes" architecture:
 *   - JS / JSX / TS / TSX is parsed with Babel; only REAL AST nodes count.
 *     A JSXText finding is a true JSXText node, never a `>...<` slice of source
 *     (so a TS generic like Array<string> can never weld to a later `<`).
 *   - String / template literals are flagged only in a small set of provably
 *     user-facing positions (user-facing JSX attrs, alert/toast/confirm/prompt
 *     calls, and assignments to text-ish identifiers) so keys / ids / classNames
 *     / imports are never touched.
 *   - Markup (.html/.vue/.svelte/.astro) is scanned structurally: bindings and
 *     directives (:placeholder, v-bind, bind:, {expr}, {{ }}) are never treated
 *     as literal text; only real literal attributes and text nodes are.
 *   - lahja REPORTS; it never edits. `--suggest` proposes a t()-wrap, applies
 *     nothing. Translation (which key, which message) stays a human decision.
 */
const path = require('path');
// Shared world-scripts table (zero-dependency \p{Script=…}). Lets every rule
// reason about ALL scripts, not just Latin/Arabic. `detectScripts(text)` returns
// the non-Latin scripts present; the `any*` helpers gate the script-aware rules.
const { detectScripts, anyNoSpaces, anyComplex } = require('@ottospace/rtl-scripts');

let babelParser, babelTraverse;
try { babelParser = require('@babel/parser'); } catch { babelParser = null; }
try { const t = require('@babel/traverse'); babelTraverse = t.default || t; } catch { babelTraverse = null; }

const JS_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const MARKUP_EXT = new Set(['.html', '.htm', '.vue', '.svelte', '.astro']);

const MSG = {
  text: 'hardcoded UI text — wrap it in your i18n t()',
  attr: 'hardcoded user-facing attribute — move it to i18n',
  str: 'hardcoded user-facing string — wrap it in your i18n t()',
  lang: 'missing lang attribute on <html> — set it from the active locale',
  format: 'bare toLocale*() uses the host locale — ok client-side; pin a locale (Intl.DateTimeFormat / NumberFormat) for SSR determinism',
  currency: 'hardcoded currency — use Intl.NumberFormat(locale,{style:"currency",currency})',
  segment: 'naive text segmentation on a no-space / complex script — use Intl.Segmenter (built-in) for word/grapheme boundaries',
};

// User-facing attributes (JSX + markup). Lowercased for markup comparison.
const UI_ATTRS = new Set(['placeholder', 'title', 'alt', 'aria-label', 'arialabel', 'label',
  'aria-placeholder', 'aria-description', 'aria-valuetext', 'aria-roledescription']);
// JSX prop spellings map to the same set (aria-label vs ariaLabel handled below).

// Identifier "words" that mean the value is display text.
const TEXTISH = new Set(['label', 'title', 'text', 'message', 'msg', 'placeholder', 'heading',
  'subheading', 'caption', 'tooltip', 'description', 'subtitle', 'cta', 'prompt', 'notice',
  'warning', 'hint', 'greeting', 'banner', 'headline', 'blurb', 'tagline', 'disclaimer',
  'confirmation', 'error', 'errormessage', 'content']);
// Identifier words that are NEVER text even if adjacent to a textish word.
const NEVER = new Set(['id', 'key', 'name', 'type', 'href', 'src', 'url', 'uri', 'path', 'rel',
  'target', 'role', 'class', 'classname', 'style', 'testid', 'slug', 'icon', 'color', 'variant',
  'value', 'field', 'ref', 'code', 'token', 'hash', 'query', 'param', 'method', 'event', 'action']);

// User-facing call sites: alert('x'), confirm('x'), toast('x'), toast.success('x'), notify('x')…
const MSG_CALLS = new Set(['alert', 'confirm', 'prompt', 'toast', 'notify', 'notification',
  'snackbar', 'enqueuesnackbar', 'message', 'showtoast', 'shownotification']);
const MSG_CALL_METHODS = new Set(['success', 'error', 'info', 'warning', 'warn', 'loading',
  'show', 'open', 'alert', 'confirm']);
// Never treat as user-facing text.
const IGNORE_CALLS = new Set(['console', 'require', 'import', 'assert', 'invariant', 'debug',
  'log', 'warn', 'error', 'trace', 'dir', 'test', 'describe', 'it', 'expect']);
// Translation helpers — a string already inside one is already handled.
const T_CALLS = new Set(['t', '$t', 'translate', 'i18n', 'usetranslations', 'formatmessage',
  'gettext', '__', 'trans', 'intl']);

// Elements whose text is code / shell / shortcuts / sample output — not translatable.
const NON_TRANSLATABLE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp', 'var']);

// JSX attributes whose string values are NEVER UI text.
const NON_UI_JSX_ATTRS = new Set(['classname', 'class', 'id', 'key', 'type', 'name', 'href',
  'src', 'to', 'path', 'rel', 'target', 'role', 'htmlfor', 'style', 'value', 'defaultvalue',
  'ref', 'slot', 'as', 'variant', 'size', 'color', 'align', 'testid', 'data-testid', 'accept',
  'method', 'action', 'autocomplete', 'inputmode', 'enterkeyhint', 'lang', 'dir', 'charset',
  'rel', 'crossorigin', 'referrerpolicy', 'integrity', 'nonce', 'kind', 'srclang']);

// Brand / product / proper-noun stoplist. A lone token equal (case-insensitively)
// to one of these is a name, not translatable UI copy — flagging "Stripe" or
// "GitHub" embarrasses the tool. Kept SMALL and unambiguous: only names that are
// not also ordinary words (so "Apple"/"Windows"/"Chrome" are NOT here — those
// fall through to the single-token Title-case → `advice` downgrade instead).
const BRAND_STOPLIST = new Set(['stripe', 'paypal', 'github', 'gitlab', 'bitbucket',
  'shopify', 'wordpress', 'woocommerce', 'figma', 'notion', 'airbnb', 'netflix',
  'spotify', 'youtube', 'tiktok', 'whatsapp', 'telegram', 'instagram', 'linkedin',
  'facebook', 'twitter', 'discord', 'slack', 'zoom', 'vercel', 'netlify', 'cloudflare',
  'mailchimp', 'twilio', 'algolia', 'supabase', 'firebase', 'mongodb', 'postgresql',
  'kubernetes', 'docker', 'nginx', 'wordpress', 'magento', 'otto', 'miraat', 'lahja',
  'kashida', 'daleel', 'mizan']);

// Is `s` a single token (no inter-word space) whose lowercase is a known brand?
function isBrandToken(s) {
  const t = String(s).trim();
  if (!t || /\s/.test(t)) return false;
  return BRAND_STOPLIST.has(t.toLowerCase());
}
// Single Latin Title-case word (Stripe, Morocco, Saved) — proper-noun-shaped, so
// lower confidence that it is translatable copy → severity `advice`, not `warning`.
function isProperNounish(s) {
  return /^[A-Z][a-z]+$/.test(String(s).trim());
}

const LETTERS = /[\p{L}]{2,}/u;
const URLISH = /^(?:https?:\/\/|\/\/|\.{1,2}\/|#|@|mailto:|tel:|\/[\w-])/i;
// Currency: symbol+amount OR amount+ISO code. Full number (fixes the $99→$9 bug).
const CURRENCY_RE = /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|SAR|AED|KWD|QAR|BHD|OMR|EGP|TRY|MAD|TND|DZD|JOD|LBP|IQD|CAD|JPY|CNY|INR|CHF|AUD)\b)/g;

function norm(s) { return String(s).replace(/\s+/g, ' ').trim().slice(0, 80); }

// Split an identifier into lowercase words (camelCase + snake + kebab).
function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

function identifierIsTextish(name) {
  const ws = words(name);
  if (!ws.length) return false;
  if (ws.some(w => NEVER.has(w))) return false;
  return ws.some(w => TEXTISH.has(w));
}

// A JSX/markup TEXT node counts if it has a real word and isn't a symbol/url/number blob.
function isUiText(raw) {
  const txt = raw.trim();
  if (!txt) return false;
  if (!LETTERS.test(txt)) return false;
  if (URLISH.test(txt)) return false;
  if (isBrandToken(txt)) return false;                       // bare brand name is not translatable UI copy
  // pure punctuation / entity noise
  if (/^[\d\s.,:;!?%$€£¥₹+\-*/=()#|@·—–…'"&]+$/.test(txt)) return false;
  return true;
}

// A bare string/template literal counts as a MESSAGE (stricter than text nodes):
// a phrase (has a space between words) OR a single Capitalized word (Save, Close).
// Rejects keys/ids/enums/urls/classNames: add_to_cart, btn-primary, en-US, addToCart.
function isLikelyMessage(str) {
  const s = str.trim();
  if (s.length < 2 || s.length > 200) return false;
  if (!LETTERS.test(s)) return false;
  if (URLISH.test(s)) return false;
  if (isBrandToken(s)) return false;                         // bare brand name (Stripe, GitHub) — not translatable copy
  if (s.includes('_')) return false;                         // snake_case key
  if (/^\S*[/\\]\S*$/.test(s) && !/\s/.test(s)) return false; // path-like
  // Script-aware: any non-Latin world script (Arabic, Thai, CJK, Indic, Hebrew…)
  // is real UI text — keys / ids / enums are ASCII by convention, and spaceless
  // scripts (CJK/Thai) would otherwise slip past the phrase + Title-case gates.
  if (detectScripts(s).length) return true;
  if (/\s/.test(s) && /[\p{L}]/u.test(s)) return true;        // a phrase
  // single token: accept only Title-cased real words (Save, Close, Submit)
  if (/^[A-Z][a-z]{1,}$/.test(s)) return true;
  return false;
}

function lineAt(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

// ---------------------------------------------------------------------------
// JS / JSX / TS / TSX (Babel)
// ---------------------------------------------------------------------------
function babelPlugins(ext) {
  const p = [];
  if (ext === '.ts' || ext === '.tsx') p.push('typescript');
  if (ext !== '.ts') p.push('jsx');
  return p;
}

// L3: is this `.length` MemberExpression used purely as a boolean/emptiness test
// (not a displayed grapheme quantity)? Those are legit even on complex scripts.
const COMPARE_OPS = new Set(['>', '<', '>=', '<=', '==', '===', '!=', '!==']);
function isLengthBooleanContext(p) {
  const parent = p.parentPath;
  if (!parent) return false;
  const pn = parent.node;
  if (!pn) return false;
  // if / while / do-while / for test, and ternary test
  if ((pn.type === 'IfStatement' || pn.type === 'WhileStatement' || pn.type === 'DoWhileStatement'
    || pn.type === 'ForStatement' || pn.type === 'ConditionalExpression') && pn.test === p.node) return true;
  if (pn.type === 'UnaryExpression' && pn.operator === '!') return true;      // !x.length
  if (pn.type === 'LogicalExpression') return true;                            // x.length && / || / ??  (a guard)
  if (pn.type === 'BinaryExpression' && COMPARE_OPS.has(pn.operator)) return true; // x.length > 0, === 0, …
  return false;
}

function scanJs(src, ext, findings, lineOffset = 0) {
  if (!babelParser || !babelTraverse) return false;
  let ast;
  try {
    ast = babelParser.parse(src, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: false,
      plugins: babelPlugins(ext),
    });
  } catch {
    return false; // parse failed → emit nothing for this file (never guess → never a FP)
  }

  const push = (rule, line, from, msg) =>
    findings.push({ rule, line: line + lineOffset, from: norm(from), msg });

  const scanTextForCurrency = (text, line) => {
    CURRENCY_RE.lastIndex = 0;
    const seen = new Set();
    let m;
    while ((m = CURRENCY_RE.exec(text)) !== null) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      push('hardcoded-currency', line, m[0], MSG.currency);
    }
  };

  // literal / no-expression-template value of a node, else null
  const literalValue = (node) => {
    if (!node) return null;
    if (node.type === 'StringLiteral') return node.value;
    if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.cooked).join(' ');
    if (node.type === 'JSXExpressionContainer') return literalValue(node.expression);
    return null;
  };

  const insideTranslationCall = (p) =>
    !!p.findParent(pp => pp.isCallExpression && pp.isCallExpression() && (() => {
      const c = pp.node.callee;
      if (c.type === 'Identifier') return T_CALLS.has(c.name.toLowerCase());
      if (c.type === 'MemberExpression' && c.property.type === 'Identifier')
        return T_CALLS.has(c.property.name.toLowerCase());
      return false;
    })());

  // ── segmentation smell (report-only) ──────────────────────────────────────
  // Naive word/char handling on scripts that need a real segmenter. A script
  // "needs a segmenter" here = it is no-space (Thai/Lao/Khmer/Myanmar/CJK — a
  // word/line break can't be found with split(' ')) OR complex (Indic/Arabic —
  // .length/.slice cut through combining marks and conjuncts).
  const hasSegScript = (text) => {
    const sc = detectScripts(text);
    return anyNoSpaces(sc) || anyComplex(sc);
  };
  // Local vars proven to hold seg-script text, so `title.slice(0,5)` is caught
  // even when the literal is a line above. Populated by the VariableDeclarator
  // visitor below (this whole traverse completes before the seg pass reads it).
  const segVars = new Map(); // var name -> true if its text is a NO-SPACE script (Thai/CJK)
  // Resolve a receiver node to visible seg-script text (a literal, or a tracked
  // var) else null → never flagged. Params/returns/unknowns stay null (zero FP).
  const segTextOf = (node) => {
    if (!node) return null;
    const v = literalValue(node);
    if (v !== null) return hasSegScript(v) ? v : null;
    if (node.type === 'Identifier' && segVars.has(node.name)) return node.name;
    return null;
  };
  // True when the seg-script node holds a NO-SPACE script (Thai/Lao/Khmer/CJK),
  // where a space/word split is wrong. Arabic/Hebrew/Indic are space-delimited.
  const segIsNoSpace = (node) => {
    if (!node) return false;
    const v = literalValue(node);
    if (v !== null) return anyNoSpaces(detectScripts(v));
    if (node.type === 'Identifier' && segVars.has(node.name)) return segVars.get(node.name);
    return false;
  };

  babelTraverse(ast, {
    JSXText(p) {
      const raw = p.node.value;
      if (!isUiText(raw)) return;
      // L1: code / shell commands / shortcuts / sample output are not translatable.
      const parent = p.parentPath && p.parentPath.node;
      if (parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment')) {
        const open = parent.openingElement;
        const nm = open && open.name && open.name.type === 'JSXIdentifier' ? open.name.name : null;
        if (nm && NON_TRANSLATABLE_ELEMENTS.has(nm.toLowerCase())) return;
      }
      const line = p.node.loc.start.line;
      push('hardcoded-text', line, raw, MSG.text);
      scanTextForCurrency(raw, line);
    },

    JSXExpressionContainer(p) {
      // A string literal rendered as an element CHILD — `<p>{'مرحبا'}</p>` — is
      // the same hardcoded text as a JSXText node, only written as an expression.
      // Deliberately narrow: only a BARE StringLiteral child. `{cond ? 'a':'b'}`,
      // `{v || 'x'}`, `{t('k')}` are non-literal expressions and are left alone;
      // attribute containers (`x={'a'}`) have their own handler.
      const parent = p.parentPath && p.parentPath.node;
      if (!parent || (parent.type !== 'JSXElement' && parent.type !== 'JSXFragment')) return;
      const expr = p.node.expression;
      if (!expr || expr.type !== 'StringLiteral' || !isUiText(expr.value)) return;
      if (parent.type === 'JSXElement') {
        const open = parent.openingElement;
        const nm = open && open.name && open.name.type === 'JSXIdentifier' ? open.name.name : null;
        if (nm && NON_TRANSLATABLE_ELEMENTS.has(nm.toLowerCase())) return;
      }
      const line = (expr.loc || p.node.loc).start.line;
      push('hardcoded-text', line, expr.value, MSG.text);
      scanTextForCurrency(expr.value, line);
    },

    JSXOpeningElement(p) {
      const nameNode = p.node.name;
      // L4: only the lowercase intrinsic <html>. A capitalized <Html> (styled /
      // Next `next/document`) is a component that renders its own root — never flag it.
      if (!nameNode || nameNode.type !== 'JSXIdentifier' || nameNode.name !== 'html') return;
      const attrs = p.node.attributes || [];
      if (attrs.some(a => a.type === 'JSXSpreadAttribute')) return; // {...props} may add lang
      const hasLang = attrs.some(a => a.type === 'JSXAttribute' && a.name &&
        a.name.name && String(a.name.name).toLowerCase() === 'lang');
      if (!hasLang) push('missing-html-lang', p.node.loc.start.line, '<html>', MSG.lang);
    },

    JSXAttribute(p) {
      const nameNode = p.node.name;
      if (!nameNode) return;
      const attrName = (nameNode.type === 'JSXNamespacedName'
        ? nameNode.namespace.name + ':' + nameNode.name.name
        : nameNode.name).toString().toLowerCase();
      if (NON_UI_JSX_ATTRS.has(attrName)) return;
      // aria-label vs ariaLabel
      const canonical = attrName.replace(/-/g, '');
      if (!UI_ATTRS.has(attrName) && !UI_ATTRS.has(canonical)) return;
      const val = literalValue(p.node.value);
      if (val === null) return;                  // {expr}, binding → dynamic, skip
      // Apply the same URL/brand/punct guards as text findings (and the markup
      // attribute path) so `title="https://…"` and `aria-label="GitHub"` are not
      // flagged as translatable copy.
      if (!isUiText(val)) return;
      const line = (p.node.value.loc || p.node.loc).start.line;
      push('hardcoded-attr', line, attrName + '="' + norm(val) + '"', MSG.attr);
    },

    CallExpression(p) {
      const callee = p.node.callee;
      let base = null, method = null;
      if (callee.type === 'Identifier') base = callee.name.toLowerCase();
      else if (callee.type === 'MemberExpression' && callee.property.type === 'Identifier') {
        method = callee.property.name.toLowerCase();
        if (callee.object.type === 'Identifier') base = callee.object.name.toLowerCase();
      }
      if (base && IGNORE_CALLS.has(base)) return;
      if (method && IGNORE_CALLS.has(method)) return;
      const isMsgCall =
        (base && MSG_CALLS.has(base) && (!method || MSG_CALL_METHODS.has(method))) ||
        (method && MSG_CALLS.has(method));
      if (!isMsgCall) return;
      for (const arg of p.node.arguments) {
        const v = literalValue(arg);
        if (v !== null && isLikelyMessage(v)) {
          const line = arg.loc.start.line;
          push('hardcoded-string', line, v, MSG.str);
          scanTextForCurrency(v, line);
          break; // first user-facing string arg is enough
        }
      }
    },

    VariableDeclarator(p) {
      const id = p.node.id;
      if (id && id.type === 'Identifier') {
        const lit = literalValue(p.node.init);       // remember seg-script vars for the segmentation pass
        if (lit !== null && hasSegScript(lit)) segVars.set(id.name, anyNoSpaces(detectScripts(lit)));
      }
      if (!id || id.type !== 'Identifier' || !identifierIsTextish(id.name)) return;
      const v = literalValue(p.node.init);
      if (v === null || !isLikelyMessage(v) || insideTranslationCall(p)) return;
      const line = (p.node.init.loc || p.node.loc).start.line;
      push('hardcoded-string', line, v, MSG.str);
      scanTextForCurrency(v, line);
    },

    ObjectProperty(p) {
      if (p.node.computed) return;
      const k = p.node.key;
      const keyName = k.type === 'Identifier' ? k.name : (k.type === 'StringLiteral' ? k.value : null);
      if (!keyName || !identifierIsTextish(keyName)) return;
      const v = literalValue(p.node.value);
      if (v === null || !isLikelyMessage(v) || insideTranslationCall(p)) return;
      const line = (p.node.value.loc || p.node.loc).start.line;
      push('hardcoded-string', line, v, MSG.str);
      scanTextForCurrency(v, line);
    },

    AssignmentExpression(p) {
      if (p.node.operator !== '=') return;
      const left = p.node.left;
      let name = null;
      if (left.type === 'Identifier') name = left.name;
      else if (left.type === 'MemberExpression' && !left.computed && left.property.type === 'Identifier')
        name = left.property.name;
      if (!name || !identifierIsTextish(name)) return;
      const v = literalValue(p.node.right);
      if (v === null || !isLikelyMessage(v) || insideTranslationCall(p)) return;
      const line = (p.node.right.loc || p.node.loc).start.line;
      push('hardcoded-string', line, v, MSG.str);
      scanTextForCurrency(v, line);
    },

    MemberExpression(p) {
      // date.toLocaleString() / toLocaleDateString() / toLocaleTimeString() with no locale
      const prop = p.node.property;
      if (p.node.computed || prop.type !== 'Identifier') return;
      if (!/^toLocale(String|DateString|TimeString)$/.test(prop.name)) return;
      const call = p.parentPath;
      if (!call || !call.isCallExpression() || call.node.callee !== p.node) return;
      if (call.node.arguments.length > 0) return; // has a locale/options → fine
      push('unlocalized-format', prop.loc.start.line, '.' + prop.name + '()', MSG.format);
    },
  });

  // ── segmentation pass ──────────────────────────────────────────────────────
  // Separate traverse so `segVars` (filled by the pass above) is complete before
  // any receiver is resolved. Only fires when the receiver is *visibly* seg-script
  // text — never on a bare param/return, so it stays false-positive free.
  babelTraverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
      const method = callee.property.name;
      if (method !== 'split' && method !== 'substring' && method !== 'substr' && method !== 'slice') return;
      const segText = segTextOf(callee.object);
      if (segText === null) return;
      const line = callee.property.loc.start.line;
      if (method === 'split') {
        const a0 = p.node.arguments[0];
        const naiveStr = a0 && a0.type === 'StringLiteral' && (a0.value === ' ' || a0.value === '');
        const naiveRe = a0 && a0.type === 'RegExpLiteral' && /\s|\\s|\\b/.test(a0.pattern);
        if (!naiveStr && !naiveRe) return;             // split(',') on CSV etc. is legit
        // A space/word split only breaks NO-SPACE scripts (Thai/Lao/Khmer/CJK).
        // Arabic, Hebrew and the Indic scripts ARE space-delimited, so splitting
        // them on a space is correct — don't flag it.
        if (!segIsNoSpace(callee.object)) return;
        const repr = a0.type === 'RegExpLiteral' ? '/' + a0.pattern + '/' : "'" + a0.value + "'";
        push('segmentation-smell', line, '.split(' + repr + ')', MSG.segment);
      } else if (p.node.arguments.length >= 1) {       // index-based truncation cuts graphemes
        push('segmentation-smell', line, '.' + method + '()', MSG.segment);
      }
    },
    MemberExpression(p) {
      // `.length` on seg-script text counts UTF-16 code units, not graphemes.
      if (p.node.computed || p.node.property.type !== 'Identifier' || p.node.property.name !== 'length') return;
      if (segTextOf(p.node.object) === null) return;
      // L3: a boolean/comparison `.length` (if (x.length), x.length > 0, x.length === 0,
      // !x.length, x.length && …) is an emptiness check — not a displayed grapheme count.
      if (isLengthBooleanContext(p)) return;
      push('segmentation-smell', p.node.property.loc.start.line, '.length', MSG.segment);
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Markup (.html/.vue/.svelte/.astro)
// ---------------------------------------------------------------------------
// Replace a region with blanks but keep newlines → line numbers stay exact.
function blankOut(src, re) {
  return src.replace(re, m => m.replace(/[^\n]/g, ' '));
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function scanMarkup(src, ext, findings) {
  const push = (rule, line, from, msg) => findings.push({ rule, line, from: norm(from), msg });
  // 1. <script> blocks → real JS/TS AST scan (catches const label = '...').
  let m;
  SCRIPT_RE.lastIndex = 0;
  while ((m = SCRIPT_RE.exec(src)) !== null) {
    const attrs = m[1] || '';
    const body = m[2];
    if (/\bsrc\s*=/.test(attrs)) continue; // external
    const jsExt = /lang\s*=\s*["']?tsx?/.test(attrs) ? '.ts' : '.js';
    const offset = lineAt(src, m.index + m[0].indexOf('>', 0) + 1) - 1;
    scanJs(body, jsExt, findings, offset);
  }

  // 2. Astro frontmatter (--- ... ---) → JS scan.
  if (ext === '.astro') {
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    if (fm) scanJs(fm[1], '.ts', findings, 1);
  }

  // Template = source with script/style/comments blanked (line-preserving).
  let tpl = blankOut(src, SCRIPT_RE);
  tpl = blankOut(tpl, /<style\b[^>]*>[\s\S]*?<\/style>/gi);
  tpl = blankOut(tpl, /<!--[\s\S]*?-->/g);
  // L1: code / pre / kbd / samp / var hold code, shell, shortcuts, sample output — not translatable.
  tpl = blankOut(tpl, /<(code|pre|kbd|samp|var)\b[^>]*>[\s\S]*?<\/\1>/gi);
  if (ext === '.astro') tpl = blankOut(tpl, /^---\n[\s\S]*?\n---/);

  // 3. <html> missing lang (real tag only).
  const HTML_RE = /<html\b([^>]*)>/gi;
  while ((m = HTML_RE.exec(tpl)) !== null) {
    if (!/\blang\s*=/i.test(m[1])) push('missing-html-lang', lineAt(tpl, m.index), '<html>', MSG.lang);
  }

  // 4. Literal user-facing attributes (skip every binding/directive).
  const ATTR_RE = /([@:#a-zA-Z][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while ((m = ATTR_RE.exec(tpl)) !== null) {
    const rawName = m[1];
    if (/^[:@#]/.test(rawName)) continue;                      // Vue :bind / @on, Svelte #, etc.
    if (/^(v-bind:|v-on:|bind:|on:|x-bind:|x-on:|use:|transition:|:)/i.test(rawName)) continue;
    const name = rawName.toLowerCase();
    if (!UI_ATTRS.has(name) && !UI_ATTRS.has(name.replace(/-/g, ''))) continue;
    const val = m[3] !== undefined ? m[3] : m[4];
    if (/\{\{|\}\}|^\{|\}$/.test(val)) continue;                // mustache / {expr} binding
    if (!isUiText(val)) continue;
    push('hardcoded-attr', lineAt(tpl, m.index), name + '="' + norm(val) + '"', MSG.attr);
  }

  // 5. Text nodes between tags.
  const TEXT_RE = />([^<>]+)</g;
  while ((m = TEXT_RE.exec(tpl)) !== null) {
    let text = m[1];
    if (/\{\{|\}\}|\{[^}]*\}/.test(text)) {                     // strip bindings, keep static text
      text = text.replace(/\{\{[\s\S]*?\}\}|\{[^}]*\}/g, ' ');
    }
    if (!isUiText(text)) continue;
    const line = lineAt(tpl, m.index + 1);
    push('hardcoded-text', line, text, MSG.text);
    CURRENCY_RE.lastIndex = 0;
    const seen = new Set();
    let cm;
    while ((cm = CURRENCY_RE.exec(text)) !== null) {
      if (seen.has(cm[0])) continue;
      seen.add(cm[0]);
      push('hardcoded-currency', line, cm[0], MSG.currency);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Ignore comments + de-dup + stable sort
// ---------------------------------------------------------------------------
const IGNORE_TOKEN = /lahja-ignore|i18nlint-ignore/;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|<!--|#|;)/;
function applyIgnores(src, findings) {
  const lines = src.split('\n');
  return findings.filter(f => {
    const here = lines[f.line - 1] || '';
    const prev = lines[f.line - 2] || '';
    if (IGNORE_TOKEN.test(here)) return false;                       // trailing or same-line ignore
    if (IGNORE_TOKEN.test(prev) && COMMENT_LINE.test(prev)) return false; // dedicated comment line above
    return true;
  });
}

const RULE_ORDER = ['missing-html-lang', 'hardcoded-text', 'hardcoded-attr', 'hardcoded-string',
  'hardcoded-currency', 'unlocalized-format', 'segmentation-smell'];
function sortFindings(findings) {
  const ri = r => { const i = RULE_ORDER.indexOf(r); return i === -1 ? 99 : i; };
  findings.sort((a, b) => a.line - b.line || ri(a.rule) - ri(b.rule) || a.from.localeCompare(b.from));
  const seen = new Set();
  return findings.filter(f => {
    const k = [f.rule, f.line, f.from].join('|');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

// `word-break: break-all` breaks a line between ANY two characters — catastrophic
// for CJK/Thai line-breaking (and rarely right anywhere). Matched textually because
// it appears in CSS, inline style attrs, and CSS-in-JS ({ wordBreak: 'break-all' })
// alike; the string is specific enough that a raw scan stays false-positive free.
const WORD_BREAK_RE = /\bword-?break\s*:\s*(?:['"`]\s*)?break-all\b/gi;
function scanWordBreak(src, findings) {
  WORD_BREAK_RE.lastIndex = 0;
  let m;
  while ((m = WORD_BREAK_RE.exec(src)) !== null) {
    // Never flag a comment that merely names the anti-pattern (AST rules skip
    // comments too — stay consistent + false-positive free).
    const lineStart = src.lastIndexOf('\n', m.index - 1) + 1;
    let lineEnd = src.indexOf('\n', m.index); if (lineEnd === -1) lineEnd = src.length;
    const lineText = src.slice(lineStart, lineEnd);
    if (src.slice(lineStart, m.index).includes('//') || COMMENT_LINE.test(lineText)) continue;
    findings.push({ rule: 'segmentation-smell', line: lineAt(src, m.index),
      from: norm('word-break: break-all'), msg: MSG.segment });
  }
}

// ---------------------------------------------------------------------------
// Shared severity contract (identical across the Miraat suite)
//   error   = mechanically certain     warning = context-inferred
//   advice  = locale / style judgment
// i18n findings are inference over source, never a proven defect, so lahja emits
// no `error`s: hardcoded UI text is context-inferred (warning); host-locale
// formatting, segmentation smells and lone proper-noun/brand tokens are judgment
// calls (advice). CI gates on severity (see bin/lahja.js): default & --check on
// `error` (so lahja never hard-fails a client build), --strict on `warning`.
function severityOf(f) {
  switch (f.rule) {
    case 'unlocalized-format':          // L2: bare toLocale* is fine client-side
    case 'segmentation-smell':          // a smell/heuristic, not a proven bug
      return 'advice';
    case 'missing-html-lang':
    case 'hardcoded-currency':
    case 'hardcoded-attr':
      return 'warning';
    case 'hardcoded-text':
    case 'hardcoded-string':
      // L5: a lone Title-case token (Stripe, Morocco, Saved) is proper-noun-shaped
      // and low-confidence as translatable copy → advice, not warning.
      return isProperNounish(f.from) ? 'advice' : 'warning';
    default:
      return 'warning';
  }
}

function scanSource(file, src) {
  const ext = path.extname(file).toLowerCase();
  let findings = [];
  if (JS_EXT.has(ext)) scanJs(src, ext, findings);
  else if (MARKUP_EXT.has(ext)) scanMarkup(src, ext, findings);
  else return { findings: [] };
  scanWordBreak(src, findings);
  findings = applyIgnores(src, findings);
  findings = sortFindings(findings);
  for (const f of findings) f.severity = severityOf(f);
  return { findings };
}

// A t()-wrap suggestion for --suggest (proposes; applies nothing).
function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'text';
}
function suggestFor(finding) {
  const key = slugify(finding.from.replace(/^[a-zA-Z-]+="|"$/g, ''));
  switch (finding.rule) {
    case 'hardcoded-text': return `{t('${key}')}`;
    case 'hardcoded-attr': {
      const attr = (finding.from.match(/^([\w-]+)=/) || [, 'attr'])[1];
      return `${attr}={t('${key}')}`;
    }
    case 'hardcoded-string': return `t('${key}')`;
    case 'hardcoded-currency': return `new Intl.NumberFormat(locale,{style:'currency',currency}).format(amount)`;
    case 'unlocalized-format': return finding.from.replace('()', '(locale)');
    case 'missing-html-lang': return '<html lang={locale}>';
    default: return null;
  }
}

module.exports = {
  scanSource, suggestFor, slugify, severityOf,
  // exported for unit tests / reuse
  isLikelyMessage, isUiText, identifierIsTextish, isBrandToken, isProperNounish,
  JS_EXT, MARKUP_EXT,
};
