# Plan: Arabic Search Normalization

Date: 2026-06-29

## Goal

Make search work for Arabic across every search surface by folding
orthographic variants before matching. Today Arabic search fails
silently: a query for `أحمد` does not find a record stored as `احمد`,
and users just conclude the product "can't find things."

## Background

Arabic readers type the same word many visually-distinct ways. The
normalization classes that matter for matching:

- **Alef variants** `أ إ آ ٱ` → `ا`
- **Hamza seats** `ؤ ئ ء`
- **Taa marbuta ↔ haa** `ة` → `ه`
- **Yaa ↔ alef maqsura** `ى` → `ي`
- **Tashkeel / harakat** (combining diacritics `U+064B–0652`,
  superscript alef `U+0670`) — strip
- **Tatweel / kashida** `U+0640` — remove
- **Presentation forms** (`U+FB50–FDFF`, `U+FE70–FEFF`) — fold to
  canonical letters (NFKC)
- **Arabic-Indic digits** (`U+0660–0669`, `U+06F0–06F9`) → ASCII

A survey of the codebase found **no reusable letter-folding primitive**.
Some surfaces strip tashkeel; **none** fold the orthographic variants —
and the variants are the _common_ query, not the edge case. Eight search
surfaces are affected (see Scope).

## Prior-Art Research (2026-06-29)

A verified multi-source research pass (Lucene, CAMeL Tools, PostgreSQL
docs, Tantivy/Quickwit maintainers) settled the build-vs-adopt question:

- **Build, don't adopt.** No library covers the full class set across our
  runtimes. The only npm options (`arajs`, `arabic-utils`; both MIT) are
  partial and unmaintained, and `arajs`'s fold directions were _refuted_
  as matching the standard — do not trust it.
- **Vendor the Lucene `ArabicNormalizer` fold table (Apache-2.0)** as the
  canonical spec, cross-checked against CAMeL Tools (MIT). Fold directions
  (ة→ه, ى→ي, alef→ا) are settled and agree across all sources.
- **The Lucene 5-fold set is NOT complete for us.** It covers only the
  three alef-seat hamzas (أ إ آ), teh-marbuta→heh, alef-maksura→yeh,
  harakat strip, tatweel removal. Extend it with: alef-wasla (ٱ U+0671,
  per CAMeL), standalone waw/yeh/bare hamza (ؤ ئ ء), superscript alef
  (U+0670), presentation-form folding (U+FB50–FDFF, U+FE70–FEFF via NFKC),
  and Arabic-Indic digits (via `@stll/stdnum`).
- **Per-runtime implementations are unavoidable** (no shared code across
  TS + SQL + Tantivy), confirming the one-spec + golden-vectors approach.
- **Postgres** has no native Arabic FTS dictionary; `unaccent` is
  Latin-only by construction; ICU collations only sort/compare and cannot
  produce a folded stored value. Hand-roll the `IMMUTABLE` function.
- **Tantivy/Quickwit** ship no Arabic analyzer (Quickwit cannot even be
  configured for one), so pre-normalize text at ingestion using the shared
  TS normalizer.

## Design Decisions

- **One spec, golden test vectors, per-runtime implementations.** Search
  spans three runtimes (Postgres SQL, Bun/Node JS, the Quickwit ingestion
  path). A single shared function cannot run in all three, so the
  canonical artifact is the **spec + a golden test-vector set**, with a
  SQL implementation and a TS implementation that are both validated
  against the same vectors. The golden vectors are the guardrail that
  keeps the two from drifting.
- **Copy the standard fold tables; do not invent them.** Base the
  transform on Lucene's `ArabicNormalizer` (Apache-2.0), cross-checked
  against CAMeL Tools (MIT) — settled fold directions: alef→ا, ة→ه, ى→ي,
  strip harakat + tatweel. Extend it for the classes Lucene omits
  (alef-wasla, waw/yeh/bare hamza, superscript alef, presentation forms,
  digits). Reuse `@stll/stdnum`'s `normalizeArabicDigits` for the digit
  class. Note: bare NFKC does _not_ fold teh-marbuta or alef-maksura
  (distinct base letters) — the explicit translate folds are still
  required on top of NFKC.
- **Design the fold table as per-language, from day one.** Lucene ships a
  _separate_ `PersianNormalizer`, and Persian/Urdu have conflicting
  letters (Persian yeh ی U+06CC vs Arabic ي U+064A; Persian kaf ک U+06A9
  vs Arabic ك U+0643). A single Arabic table would mis-fold `fa`/`ur`, so
  the package exposes per-language fold tables rather than one global
  Arabic table — this avoids a rewrite when those locales land.
- **Normalization is a match-key transform only — never mutate stored or
  displayed text.** Folding `ة→ه` is lossy and changes meaning. It
  applies to index/comparison keys; display always renders the original.
- **Symmetry is mandatory for full-text search.** Index terms and the
  query must be normalized identically or they cannot match. This is why
  the FTS surfaces need a reindex/backfill, not just a query-side change.
- **DB surfaces normalize in SQL; in-memory/client surfaces normalize in
  TS.** For Postgres, an `IMMUTABLE` `arabic_normalize(text)` function
  drives both a `GENERATED ... STORED` column and the query expression —
  so it auto-maintains on write with no write-path changes, and there is
  one SQL impl for all DB surfaces. The TS normalizer covers the
  in-memory regex search, the client find-in-page, and the Quickwit
  ingestion/query path.
- **Add a structural guardrail after the primitive exists** so the
  eight-surfaces-drift-apart problem cannot recur, mirroring the existing
  `no-raw-date-input` oxlint rule.

## Scope

**In scope (the eight surfaces):**

1. Global entity FTS — `apps/api/src/lib/search/query.ts`
   (`removeSearchDiacritics` / `normalizeTextForLexemes` chokepoint).
   Also fixes a latent asymmetry: query strips diacritics in JS but the
   index uses SQL `unaccent` — both sides must use the identical
   normalizer.
2. Legal corpus search (Quickwit) —
   `apps/api/src/lib/legal-search/corpus-index-config.ts` (`default`
   tokenizer) + `corpus-query.ts`.
3. Legal PG fallback — `handlers/case-law/decisions/search.ts`,
   `handlers/legislation/search.ts`,
   `lib/legal-search/pg-fts-legal-provider.ts`.
4. Contacts quick search — `handlers/contacts/search.ts` (raw `ILIKE`).
5. Chat entity-content search —
   `handlers/chat/tools/execute/workspace-function-registry.ts`
   (`findHitsInText`, raw regex).
6. Client case-law find-in-page —
   `apps/web/src/features/case-law/components/case-viewer/decision-search.ts`
   (diacritic strip only).
7. Clauses FTS — `handlers/clauses/search-vector.ts`. **Pre-existing
   bug**: `to_tsvector('english', …)` (wrong language config + no
   `unaccent`) is broken for _all_ non-English UI languages already
   shipped (cs/de/pl/…), not just Arabic. Fix as a separate commit.

**Out of scope:**

- Arabic stemming / morphological (root-based) analysis. Normalization is
  not stemming; light-stemming is a possible future enhancement.
- Improving `@stll/anonymize-wasm` Arabic PII _matching_ quality (surface
  8, `lib/anonymization-blacklist.ts`). Related but a separate, larger
  NER effort; this plan only ensures the blacklist call site normalizes
  its keys consistently if cheap, otherwise tracks it separately.
- Modifying the `@stll` wasm library internals (aho-corasick, regex-set,
  fuzzy-search). Their `normalizeDiacritics` flag stays opt-in; we
  normalize at our call sites instead.
- Having Arabic legal corpus _content_ (Arabic case law/statutes).

## PR Sequencing

Each PR is independently shippable and verifiable. Start with PR1.

### PR1 — Canonical normalizer + low-risk surfaces (start here)

Highest everyday-search value, lowest risk, no reindex.

- Add the **TS normalizer** + golden test-vector set + property tests.
- Add the **SQL `arabic_normalize()`** `IMMUTABLE` function (migration)
  and a test asserting SQL output equals TS output over the golden
  vectors.
- Wire the surfaces that need no reindex: contacts `ILIKE` (normalized
  generated column + normalized query), chat `findHitsInText` (normalize
  both sides in memory), client find-in-page (extend existing TS
  normalize), and extend the `query.ts` helper.
- Separate commit: fix the clauses `'english'` → `'simple'` +
  normalizer bug.

### PR2 — Postgres FTS symmetry + backfill

- Regenerate the entity / legal-PG tsvectors from `arabic_normalize()`
  (generated STORED column or normalized source), fix the JS/SQL
  asymmetry, migration + backfill of existing rows.

### PR3 — Quickwit corpus (heaviest; gated)

- Normalize the indexed text field at ingestion + normalize the query in
  `corpus-query.ts`, both via the TS normalizer; keep an unmodified
  stored field for display/highlight. Requires a **full corpus reindex**
  — sequence this once the corpus ingestion pipeline is stable.

### PR4 — Structural guardrail

- Custom oxlint rule (mirroring `no-raw-date-input`) flagging raw
  `ilike` / `to_tsquery` / `plainto_tsquery` / `new RegExp` on
  user-search input that bypasses the normalizer.

## Implementation

- **Shared TS normalizer** — new package `@stll/text-normalize`
  (confirmed), importable by both `apps/api` and `apps/web` so the API and
  the client run the identical function. Pipeline: NFKC (folds
  presentation forms) → strip tashkeel + superscript alef → remove tatweel
  → fold alef variants + alef-wasla + hamza seats + taa-marbuta + yeh →
  digit normalization (reuse `@stll/stdnum`) → lowercase → collapse
  whitespace. Exposes a per-language fold table (Arabic first).
- **SQL `arabic_normalize(text) IMMUTABLE`** — hand-authored timestamped
  migration (never `drizzle-kit generate`); Postgres `normalize(… NFKC)`
  - `translate()` + `regexp_replace()` for the fold classes. Drives
    generated columns + query expressions. Respect squawk migration lint
    (lock/statement timeouts; explicit short index names).
- **DB call sites** — replace `unaccent(…)` / bare `ILIKE` /
  `to_tsquery('simple', …)` with the `arabic_normalize()`-wrapped
  equivalents on both index and query sides. Keep all existing tenant /
  workspace filters intact.
- **Quickwit (PR3)** — normalize at the ingestion call site and in
  `corpus-query.ts`; index config keeps `default` tokenizer operating on
  pre-normalized text.
- **DB schema** — new generated/normalized columns + GIN indexes for the
  ILIKE/FTS surfaces; tsvector regeneration. All additive.

## Test Cases

- **Golden vectors** (shared by SQL + TS impls): `أحمد`/`احمد`,
  `خدمة`/`خدمه`, `يكفى`/`يكفي`, tatweel `مـحـمـد`→`محمد`, a presentation
  form folding to canonical, digits `٢٠٢٤`/`2024`, mixed Latin+Arabic.
- **Idempotence** property: `normalize(normalize(x)) === normalize(x)`.
- **Cross-impl agreement**: SQL `arabic_normalize()` output equals TS
  output across the golden vectors (DB integration test).
- **Per-surface**: contacts/entity/legal search returns the record when
  query and stored value differ only by a normalized class; clauses FTS
  matches a non-English (e.g. German) term after the `'simple'` fix.
- **ReDoS check**: the fold is linear `translate`/char-class work; assert
  no catastrophic backtracking on adversarial input.

## Security Notes

- Search stays workspace/tenant-scoped; normalization does not touch auth.
  Normalized generated columns must remain inside existing tenant filters
  (no cross-tenant leakage). Normalizing user input is linear/non-ReDoS.

## Open Questions

- **Hamza-seat fold target** — for ؤ ئ ء Lucene gives no rule. Recommended
  default for search recall: ؤ→و, ئ→ي, drop standalone ء. Worth confirming
  with the native legal-Arabic reviewer (one-line table change; golden
  vectors will pin whatever we choose).
- **Postgres NFKC presentation-form coverage** — verify empirically that
  `normalize(text, NFKC)` folds U+FB50–FDFF / U+FE70–FEFF before relying
  on it in the generated column (first task of PR2's SQL piece; fall back
  to an explicit translate table if not).
- **Persian/Urdu fold tables** — out of scope here, but the per-language
  design must be in place so `fa`/`ur` are additive.

(Resolved: new `@stll/text-normalize` package; anonymisation surface
deferred to a separate NER-quality effort.)
