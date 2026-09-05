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
3. Run `bun run i18n:sync` from `apps/web`. This synchronizes locale
   structure, regenerates typed messages, and updates generated glossary
   output. Never edit `messages.gen.ts` or generated terminology tables by
   hand.
4. Run `bun run i18n:check` from `apps/web`. Typecheck does not regenerate or
   validate the catalogs, so a clean typecheck is not evidence that i18n is in
   sync.
5. Read the rendered sentence in context, including interpolation and plural
   branches. Passing key parity is not proof that a translation is natural or
   that placeholders remain grammatically valid.

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

When a translation key crosses indirection through a constant, map, prop, or
helper return type, type it with `TranslationKey` from
`apps/web/src/i18n/types` instead of `string`. Missing or stale keys must fail
typecheck at the point where they are stored.

Prefer complete translatable sentences over fragments assembled in JSX. Keep
interpolation variables semantic (`{documentName}`, not `{value}`), use ICU
plural/select branches for grammatical variation, and never concatenate
translated fragments whose word order differs by locale.

**Never call anything an "entity" in user-facing copy**, in English or as a
calque (`entita`, `Entität`, `entidad`, `entité`, `entidade`, `encja`, ...).
It is the database's word for a row and means nothing to a lawyer. Name the
concrete thing the string is about — document, file, folder, task, matter —
and fall back to "item" only when the string genuinely covers all of them. In
anonymization, what the detector finds is a **match**, not an entity. The
`item` concept in `glossary.json` enforces this with `forbiddenAlways`, so it
fires on the English source too, not only on translations.

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
4. **Pick the right ban field.** `forbidden` is concept-gated: it fires
   only where the English source names the concept (or a `keyTriggers`
   path matches), which is what stops a common word from false-firing
   everywhere. `forbiddenAlways` drops that gate, for wording that is
   wrong in every context. Use it when a concept-gated ban would go
   blind the moment someone rewords the English source, and only once
   you have checked that no legitimate use of the word exists in that
   locale.
5. **Apply consistently.** `bun run i18n:check` fails on new
   forbidden renderings; fix the translations, or — only for
   genuine pre-existing debt — grandfather with
   `i18n-lint <dir> --write-baseline` and flag for native review.

## Landing (marketing) catalogs

The landing app has its own catalogs (`apps/landing/src/i18n/messages/`)
with the same glossary enforcement plus marketing-specific rules —
register per locale, the identity phrase, hero structure differences,
meta-string length budgets, cognate policy, and brand handling. Before
translating landing strings, read
`apps/landing/src/i18n/TRANSLATION.md`; it explains the intent behind
each rule so translations stay coherent rather than merely passing the
checks. Landing gates: `bun run i18n:sync` and `bun run i18n:check`
from `apps/landing`.
