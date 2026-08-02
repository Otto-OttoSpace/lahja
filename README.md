# lahja

**Find the user-facing strings AI code tools hardcode instead of translating.**

> *lahja* (لهجة) — an accent, a dialect, a way of speaking. Ship your UI in every one.
> Formerly **i18nlint**.

AI codegen ships English text baked straight into JSX, un-localized dates and currency, and no `<html lang>`. It looks done — until you try to ship in a second language and half the UI is hardcoded. `lahja` scans your React / Next / Vue / Svelte / Astro / HTML and reports every string a user reads that isn't translated yet.

It is **AST-verified** (Babel for JS/TS/JSX/TSX): only real syntax nodes count, so live code — TS generics like `Array<string>`, object keys, ids, classNames, imports — and dynamic markup bindings (`:placeholder`, `v-bind`, `bind:`, `{expr}`) are **never** mistaken for UI text.

```bash
npx lahja .                 # report untranslated strings
npx lahja . --json          # machine-readable + severity summary (CI)
npx lahja . --check         # CI gate on errors only (lahja emits none → passes)
npx lahja . --strict        # fail on warnings too (the usual CI gate for lahja)
npx lahja . --report-only   # always exit 0 (report, never gate)
npx lahja . --baseline      # accept today's debt, then fail only on NEW strings
npx lahja . --suggest       # PROPOSE a t()-wrap for each finding (writes nothing)
npx lahja . --init-rules    # write I18N-RULES.md for your AI agent
```

## Severity — so it never hard-fails a client build by surprise
Every finding is **`error` | `warning` | `advice`** (JSON adds `severity` per finding plus a
`summary`). i18n detection is inference over source, not a proven defect, so lahja emits **no
`error`s**: hardcoded UI text is a **warning** (context-inferred); a bare `toLocaleString()`, a
segmentation smell, and a lone brand/proper-noun token (`Stripe`, `Morocco`) are **advice**.
Exit is non-zero **only** on an `error`, so a plain run or `--check` never fails a build — gate
CI with **`--strict`** (fails on warnings). Known brand names are skipped; `<code>`/`<pre>`/`<kbd>`
content, `<Html>` components, and `if (x.length)` emptiness checks are never flagged.

## What it catches
- **Hardcoded JSX / markup text** — `<h1>Your cart</h1>` → wrap in `t()`
- **Hardcoded string literals** — `const label = 'Add to cart'`, `alert('Saved')`, `toast(\`...\`)`
- **User-facing attributes** — `placeholder`, `title`, `alt`, `aria-label`, `label` (single- or double-quoted, and `={'…'}`)
- **Un-localized formatting** — a bare `toLocaleDateString()` with no locale
- **Hardcoded currency** — `$99.00` → `Intl.NumberFormat`
- **Missing `<html lang>`**

## Zero mistakes, by design
Every audited false-positive is a permanent test in `test/corpus/` and `node --test`:
a TS generic never welds across lines, `<html>` in a string is not a missing-lang, a Vue
`:placeholder="msg"` binding is never flagged, keys/ids/classNames/imports are left alone.

## Ignoring & baselines
- Silence one line with a `// lahja-ignore` comment (on the line or the comment line above it).
- Skip whole paths with a `.lahjaignore` file (one glob/substring per line).
- Adopt lahja on a legacy codebase with `--baseline`: the first run snapshots existing debt to
  `.lahja-baseline.json`; later runs fail **only** on strings you add. `--update-baseline` re-snaps.

## Why it only reports (never edits)
Translating is a human decision — which key, which message, which namespace. lahja won't guess. `--suggest` will *propose* a `t()`-wrap diff, but applies nothing. It just guarantees nothing user-facing slips through untranslated, and its `--init-rules` file stops your AI agent from adding more.

## In your AI agent (MCP)
```json
{ "mcpServers": { "lahja": { "command": "npx", "args": ["-y", "-p", "github:Otto-OttoSpace/lahja", "lahja-mcp"] } } }
```
Tools: `lahja_scan`, `lahja_check_code`.

---
Part of **[Otto](https://dev.ottospace.co)** — tools that make the AI-built web work in every language. MIT © 2026

## 💛 Support & commercial use

The Miraat suite is free and open-source (MIT). If it helps you ship correct Arabic/RTL, please consider [sponsoring on GitHub](https://github.com/sponsors/Otto-OttoSpace) — it funds maintenance and new rules.

Using it in a commercial product, in CI, or need the private **DGA compliance** rule pack? A **Miraat Pro** commercial licence — commercial use, a hosted CI audit that gates PRs ([miraat-action](https://github.com/Otto-OttoSpace/miraat-action)), and priority support — is available. Email **work@ottospace.co** and we'll set you up.
