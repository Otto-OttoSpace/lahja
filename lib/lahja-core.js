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
  format: 'toLocale*() with no locale — pass one (Intl.DateTimeFormat / NumberFormat)',
  currency: 'hardcoded currency — use Intl.NumberFormat(locale,{style:"currency",currency})',
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

// JSX attributes whose string values are NEVER UI text.
const NON_UI_JSX_ATTRS = new Set(['classname', 'class', 'id', 'key', 'type', 'name', 'href',
  'src', 'to', 'path', 'rel', 'target', 'role', 'htmlfor', 'style', 'value', 'defaultvalue',
  'ref', 'slot', 'as', 'variant', 'size', 'color', 'align', 'testid', 'data-testid', 'accept',
  'method', 'action', 'autocomplete', 'inputmode', 'enterkeyhint', 'lang', 'dir', 'charset',
  'rel', 'crossorigin', 'referrerpolicy', 'integrity', 'nonce', 'kind', 'srclang']);

const LETTERS = /[\p{L}]{2,}/u;
const URLISH = /^(?:https?:\/\/|\/\/|\.{1,2}\/|#|@|mailto:|tel:|\/[\w-])/i;
// Currency: symbol+amount OR amount+ISO code. Full number (fixes the $99→$9 bug).
const CURRENCY_RE = /(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|SAR|AED|CAD|MAD|JPY|CNY|INR|CHF|AUD)\b)/g;

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
  if (s.includes('_')) return false;                         // snake_case key
  if (/^\S*[/\\]\S*$/.test(s) && !/\s/.test(s)) return false; // path-like
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

  babelTraverse(ast, {
    JSXText(p) {
      const raw = p.node.value;
      if (!isUiText(raw)) return;
      const line = p.node.loc.start.line;
      push('hardcoded-text', line, raw, MSG.text);
      scanTextForCurrency(raw, line);
    },

    JSXOpeningElement(p) {
      const nameNode = p.node.name;
      if (!nameNode || nameNode.type !== 'JSXIdentifier' || nameNode.name.toLowerCase() !== 'html') return;
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
      if (!LETTERS.test(val)) return;
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
  if (ext === '.astro') tpl = blankOut(tpl, /^---\n[\s\S]*?\n---/);

  // 3. <html> missing lang (real tag only).
  const HTML_RE = /<html\b([^>]*)>/gi;
  while ((m = HTML_RE.exec(tpl)) !== null) {
    if (!/\blang\s*=/.test(m[1])) push('missing-html-lang', lineAt(tpl, m.index), '<html>', MSG.lang);
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
  'hardcoded-currency', 'unlocalized-format'];
function sortFindings(findings) {
  const ri = r => { const i = RULE_ORDER.indexOf(r); return i === -1 ? 99 : i; };
  findings.sort((a, b) => a.line - b.line || ri(a.rule) - ri(b.rule) || a.from.localeCompare(b.from));
  const seen = new Set();
  return findings.filter(f => {
    const k = [f.rule, f.line, f.from].join('|');
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

function scanSource(file, src) {
  const ext = path.extname(file).toLowerCase();
  let findings = [];
  if (JS_EXT.has(ext)) scanJs(src, ext, findings);
  else if (MARKUP_EXT.has(ext)) scanMarkup(src, ext, findings);
  else return { findings: [] };
  findings = applyIgnores(src, findings);
  findings = sortFindings(findings);
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
  scanSource, suggestFor, slugify,
  // exported for unit tests / reuse
  isLikelyMessage, isUiText, identifierIsTextish,
  JS_EXT, MARKUP_EXT,
};
