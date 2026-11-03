# @stll/text-normalize

Search match-key text normalization. Folds orthographic variants so a
search query matches text regardless of how it was typed.

The normalized output is a **match key**: it is lossy and intended only
for indexing and query comparison. Never store or display it in place of
the original text.

## Arabic

`arabicNormalize` folds the orthographic variants that make Arabic
search miss otherwise-identical words:

- alef variants and alef-wasla (`أ إ آ ٱ`) to bare alef `ا`
- waw-hamza `ؤ` to `و`, yeh-hamza `ئ` to `ي`, standalone hamza `ء` dropped
- teh marbuta `ة` to heh `ه`
- alef maksura `ى` to yeh `ي`
- tashkeel (harakat), superscript alef, and tatweel removed
- Arabic-Indic and Extended Arabic-Indic digits to ASCII

It also runs NFKC (folding presentation forms), locale-stable ASCII case
folding, and whitespace collapse, so it is a safe pass-through for
non-Arabic scripts.

The fold tables are vendored from Lucene's `ArabicNormalizer` (Apache-2.0)
and cross-checked against CAMeL Tools (MIT), extended for the classes
Lucene omits.

```ts
import { arabicNormalize } from "@stll/text-normalize";

arabicNormalize("أحمد") === arabicNormalize("احمد"); // true
```

The same fold must be reproduced by the PostgreSQL `arabic_normalize()`
function used in contacts trigram expression indexes and search predicates;
the golden vectors in `src/normalize.test.ts` pin the shared contract.

## Diacritics

`stripDiacritics` decomposes with NFD and removes every combining mark
(`\p{Diacritic}`, so marks beyond the U+0300–U+036F block are covered
too). Use it for accent-insensitive search keys.

`foldToAscii` keeps that strip as its base and adds the folds a
decomposition cannot express, so it matches PostgreSQL `unaccent()` for
every Latin-script character for which the extension declares a rule:
`ł` to `l`, `đ` to `d`, `ø` to `o`, `ß` to `ss`, `æ` to `ae`, and the
rest of the table in `src/ascii-fold-table.ts`. Use it wherever the
counterpart is an `unaccent`-folded index (or a Tantivy `ascii_folding`
one); a plain mark strip leaves `ł` standing and under-matches the
lexemes the index actually stored. Non-Latin scripts are out of contract
and pass through with their marks stripped.

`foldLikePostgresSearch` (`@stll/text-normalize/postgres-search-fold`) is PostgreSQL's `lower(unaccent(...))` itself,
code point for code point and every script included, from the
extension's full rule set (`POSTGRES_UNACCENT_RULES`). Use it where a
client must agree with a server-side `unaccent` match exactly, such as a
highlighter marking what the server found:
`findPostgresSearchFoldRanges` returns those marks as ranges into the
original text. It is narrower than the client search fold below: it keeps
marks and letters the extension keeps.

`stripDiacriticsForSlug` is the same strip but decomposes with NFKD, so
compatibility characters (ligatures, full-width forms, superscripts) fold
to their base before a `[a-z0-9]` slug filter runs. Slugs are persisted,
public URL segments; this variant pins the exact form existing slugs were
generated with.

## Substring matching with highlight offsets

`createSearchQueryMatcher(query)` (from `@stll/text-normalize/search-query-matcher`) is the client-side answer to "does this
text match what the user typed": it trims and folds the query once and returns
a predicate over candidate texts (a blank query matches everything, a missing
candidate nothing). `filterBySearchQuery({ items, query, fields })` applies it
to a list, keeping the items any field of which matches. Use these for every
picker, list filter and typeahead, so a query typed without accents (`dvorak`,
`strasse`, `lodz`) finds the same items everywhere and in every UI locale. An
`Intl.Collator` with `sensitivity: "base"` is not an alternative: it compares
equal-length windows (`strasse` misses `Straße`), its verdict depends on the
runtime locale, and it keeps Arabic tashkeel significant.

`foldSearchMatchText` is the match key both sides are folded with: NFKD, the `unaccent()`-parity ASCII folds, mark strip, Arabic
folds, lowercase — `capek` matches `Čapek` and `wroclaw` matches
`Wrocław`, both ways. `findSearchMatchRanges` finds a folded query in
folded content and returns ranges into the **original** string, so
highlights wrap the text the user sees even where folding changes string
length; it accepts content pre-folded with `foldSearchMatchTextWithOffsets`
so repeated queries against the same text fold it once.

Import the literal helpers from `@stll/text-normalize/search-match-key`:

```ts
import {
  containsSearchMatchKey,
  findSearchMatchKeyRanges,
} from "@stll/text-normalize/search-match-key";
```

`containsSearchMatchKey(content, query)` checks a literal substring in keys
already prepared by the caller, such as fixed tokens in a message or keys a
caller folded itself. It does not trim or fold either input; a user-typed query
goes through `createSearchQueryMatcher` instead. Empty queries match every key. For accent-insensitive highlight ranges into original
text, use `findSearchMatchRanges` from `@stll/text-normalize` instead.

`findSearchMatchKeyRanges(content, query, { start?, end?, maxMatches? })`
returns non-overlapping literal matches as UTF-16 ranges into `content`.
It applies no trimming, case conversion, or diacritic folding. Empty queries return no ranges; this differs from
`containsSearchMatchKey`, where an empty query passes a list filter.

`start` is inclusive and `end` exclusive; both default to the content's
bounds, are truncated to integers, and clamped to `[0, content.length]`.
Only complete matches inside that window are returned. `maxMatches` is
floored; zero or negative limits, reversed windows, and NaN options return
no ranges. Infinite bounds clamp to the content and an infinite limit
returns all matches. Use `{ maxMatches: 1 }` for the first occurrence of a
scope, then pass its `start` and `end` to search within that scope. Existing
callers retain their own casing or folding before calling either helper.

## Spaced letters

`collapseSpacedLetters` joins letter-spaced court headings
(`r o z h o d o l :` to `rozhodol:`) back into searchable words. It
requires at least four spaced letters, so Czech/Slovak single-letter word
lists (`a b c`) are left intact. `spacedLetterRunRegex()` returns the
underlying matcher for callers that need per-match offsets (find-in-page
highlighting). Index-time and query-time collapse share this one
threshold so a heading collapses identically on both sides.

Both match-key helpers replace lone surrogates with U+FFFD on both sides via
`toWellFormed()` before matching Unicode scalars. A lone surrogate can match
U+FFFD or another lone surrogate, and cannot match half of an astral character.
Offsets remain UTF-16 offsets into the well-formed content; replacement does not
change its length. Caller-owned case, accent, and whitespace policies remain.
