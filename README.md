# i18nlint

**Find the user-facing strings AI code tools hardcode instead of translating.**

AI codegen ships English text baked straight into JSX, un-localized dates and currency, and no `<html lang>`. It looks done — until you try to ship in a second language and half the UI is hardcoded. `i18nlint` scans your React / Next / Vue / Svelte / HTML and reports every string a user reads that isn't translated yet.

```bash
npx i18nlint .              # report untranslated strings
npx i18nlint . --json       # machine-readable (CI)
npx i18nlint . --init-rules # write I18N-RULES.md for your AI agent
```

## What it catches
- **Hardcoded JSX text** — `<h1>Your cart</h1>` → wrap in `t()`
- **User-facing attributes** — `placeholder`, `title`, `alt`, `aria-label`, `label`
- **Un-localized formatting** — a bare `toLocaleDateString()` with no locale
- **Hardcoded currency** — `$99.00` → `Intl.NumberFormat`
- **Missing `<html lang>`**

## Why it only reports (never edits)
Translating is a human decision — which key, which message, which namespace. i18nlint won't guess. It just guarantees nothing user-facing slips through untranslated, and its `--init-rules` file stops your AI agent from adding more.

## In your AI agent (MCP)
```json
{ "mcpServers": { "i18nlint": { "command": "npx", "args": ["-y", "-p", "github:moradothmanepro-OTTO/i18nlint", "i18nlint-mcp"] } } }
```
Tools: `i18n_scan`, `i18n_check_code`.

---
Part of **[Otto](https://dev.ottospace.co)** — tools that make the AI-built web work in every language. MIT © 2026
