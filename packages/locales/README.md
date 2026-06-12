# @stll/locales

Single canonical list of ISO 639-1 living languages, plus the derived subset of
languages the stella UI ships translations for.

- `LANGUAGES` — every ISO 639-1 living language as
  `{ code, englishName, endonym, uiAvailable, uiLocale? }`, frozen as a readonly
  tuple so derived types are literal unions.
- `UI_LANGUAGES` — the `uiAvailable` subset (the shipped UI languages).
- `UI_LOCALES` — the exact i18n message-file tags (`en`, `cs`, …, `pt-BR`, `sk`).
- Types: `Language`, `LanguageCode`, `UiLocale`.

## Helpers

- `isLanguageCode(value)` — base ISO 639-1 code guard.
- `isUiLocale(value)` — message-file tag guard.
- `resolveUiLocale(value)` — resolve an arbitrary locale to a shipped UI tag
  (exact match, base-code prefix, and the `pt* -> pt-BR` special case).
- `toLanguageCode(value)` — canonicalize a (possibly regional) tag to its base
  ISO 639-1 code, or `null`.
- `displayLanguageName(tag, options)` — endonym/English name with an
  `Intl.DisplayNames` fallback.

## The Portuguese wrinkle

`LANGUAGES` is keyed by ISO 639-1 base codes, so Portuguese is `pt`. The shipped
UI locale is the regional tag `pt-BR`; that tag lives on the entry's `uiLocale`
field and in `UI_LOCALES`. `resolveUiLocale` preserves the historical
`pt -> pt-BR` fallback.
