---
name: conventions-i18n
description: "Internationalization conventions for Stella. Apply when adding or modifying user-facing strings."
---

# i18n Conventions

Internationalization conventions for Stella. Apply when adding or
modifying user-facing strings.

## Stack

`use-intl` for runtime.

## Supported Languages

en is the source language. Check `apps/web/src/i18n/langs/` for
the current list of target languages (add translations to every
`.json` file found there).

## Translation Flow

1. Add or modify keys in
   `apps/web/src/i18n/langs/en.json`.
2. Add corresponding translations to **all target language files**
   found in `apps/web/src/i18n/langs/` (every `.json` file
   except `en.json`). Write natural, idiomatic translations;
   avoid literal/robotic phrasing.
3. Run `bun run typegen` (from `apps/web`) to regenerate type
   declarations. It does **not** run during `bun run typecheck`;
   drift and untranslated values are caught by `bun run i18n:check`
   (pre-push).

## Key Naming

**Prefer generic, reusable keys over feature-specific ones.**
Before adding any new i18n key, search `en.json` for an existing
key with the same or similar wording (e.g., `common.filter`,
`common.sort`, `common.columns`). Reuse `common.*` or shared
namespace keys instead of creating feature-scoped duplicates
like `billing.expenses.deleteExpense`. Feature-specific keys
are only justified when the wording truly differs from the
generic version (e.g., a confirmation message that mentions
the resource by name).

Key naming, pluralization, and style rules are documented
in `apps/web/src/i18n/TERMINOLOGY.md`.
