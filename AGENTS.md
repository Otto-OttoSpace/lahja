# AGENTS.md — i18n rules for AI agents

Any agent writing UI in this repo must:
1. **Never hardcode user-facing text** — wrap every string a user reads in the project's translation function (`t()`, `useTranslations()`, `<FormattedMessage>`, `$t()`).
2. **Localize user-facing attributes** too: `placeholder`, `title`, `alt`, `aria-label`, `label`.
3. **Never hand-format** dates/times/numbers or use a bare `toLocaleString()` — use `Intl.DateTimeFormat` / `Intl.NumberFormat` with an explicit locale.
4. **Never hardcode currency** — use `Intl.NumberFormat(locale, { style: 'currency', currency })`.
5. **Set `<html lang>`** (and `dir`) from the active locale.

Run `npx i18nlint .` before finishing — it must report zero untranslated strings.
