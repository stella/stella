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

## Terminology (glossary)

Canonical legal/domain terms live in
`apps/web/src/i18n/glossary.json` (the source of truth);
`glossary-gen` renders them into the tables in `TERMINOLOGY.md`.
The `i18n-lint` checker enforces them: per concept it flags a
translation that uses a `forbidden` rendering when the English
source is about that concept (concept-gated, so a common word only
fires in the right context).

When introducing a NEW concept (or changing a preferred term):

1. **Research it first.** Confirm the sector-standard term and the
   synonyms to avoid in **each** language against authoritative
   sources (IATE/EU terminology, national legal glossaries,
   established legal-tech usage) — do not guess. Record the
   rationale in the concept's `note`.
2. **Add it to `glossary.json`**, never only to `TERMINOLOGY.md`
   (the `.md` is generated). Run `bun run i18n:sync` (from
   `apps/web`) to regenerate the tables.
3. **Account for declensions/inflections.** The lint matches
   forbidden terms whole-word (English source triggers also match
   their regular plural), so list the actual inflected, declined,
   and compound forms a translator might use — e.g. de
   `Sache`/`Sachen`/`Mandatsdaten`, sk `Vec`/`veci`/`vecou`, et
   `asi`/`asja`/`asjad`. A base form alone misses inflected drift.
4. **Apply consistently.** `bun run i18n:check` fails on new
   forbidden renderings; fix the translations, or — only for
   genuine pre-existing debt — grandfather with
   `i18n-lint <dir> --write-baseline` and flag for native review.
