# 054 — Statutes ingestion: Slovakia (Slov-Lex) and Czechia (eSbírka)

## Goal

Consolidated, point-in-time statutes searchable and readable next to case law.
Slice 1 proves parser → search → reader on a handful of curated codes; history
and breadth follow.

## Current state (origin/main @ 1c519f3273)

The legislation slice is a complete substrate with **no producer**:

- `apps/api/src/db/schema/legislation.ts` already realises FRBR
  Work/Expression: `legislation_documents` is one row per version, unique on
  `(source_id, eli, version_valid_from, language)`
  (`legislation_documents_eli_version_lang_idx`), with a second partial unique
  index for the `version_valid_from IS NULL` case, plus `version_valid_to`,
  `effective_date`, and a `status` CHECK over
  `current|historical|repealed|draft`. `legislation_sources` carries
  `adapter_key`, `sync_cursor`, and a redistribution `descriptor`.
- `apps/api/src/handlers/legislation/ingestion.ts:38` —
  `LegislationDocumentInput` already accepts `sections`, `ast`,
  `versionValidFrom/To`. `processLegislationDocument` dedups on a hash over
  every persisted field, writes object storage, and clears `indexedHash`.
  Sanitisation is pipeline-level (`sanitizeInput`, via
  `apps/api/src/lib/legal-search/corpus-sanitize.ts`), so adapters must not
  sanitise.
- `runLegislationIngestion` (`ingestion.ts:344`) has **zero callers** —
  `grep -rn runLegislationIngestion apps packages scripts` returns only its
  definition. No adapter registry, no source seeder, no scheduler task
  (`apps/api/src/lib/scheduler/tasks/` has none).
- Search (`handlers/legislation/search.ts`) and reader
  (`handlers/legislation/get.ts`, routed in `corpus-routes.ts` as
  `POST /legislation/corpus/search`, `GET /legislation/corpus/:documentId`)
  exist. Neither knows `asOf`.
- `grep -rln legislation apps/web/src/routes` is empty: no web surface. The
  public case-law shell is `apps/web/src/routes/law/-components/public-law-shell.tsx`
  under `/law/$country/cases/...`.

### Conflicts to resolve, not average

1. **Two adapter contracts.** `LegislationAdapter` (`ingestion.ts:~70`) is a
   two-field stub (`adapterKey`, `fetchPage`). The well-tested contract is
   `SourceAdapter` / `defineSourceAdapter`
   (`apps/api/src/lib/legal-search/ingestion-types.ts:467,545`): `fetchPage`
   returns `Result<SyncPage, AdapterFetchError>`, plus `minRequestIntervalMs`,
   `pageTimeoutMs`, `maxSyncPages`, mandatory `getTotalCount`, and a
   `reconciliation` field answerable with `ReconciliationUnsupported`.
   **Adopt the case-law shape; the stub loses.** Slice 0 replaces it.
2. **`sourceRaw` has nowhere to go.** Case-law `IngestionResult` carries
   `sourceRaw`/`sourceRawContentType`/`rawHash`; `LegislationDocumentInput`
   has only `metadata`. CLAUDE.md rule 3 ("always save sourceRaw") cannot be
   honoured without adding those fields. Slice 0 adds them.
3. **Coverage machinery is case-law-typed.** `coverage-ledger.ts`,
   `reconciliation-engine.ts`, and `source-totals.ts` import
   `caseLawCoverageSlices` / `caseLawDecisions` / `caseLawSources` directly and
   cannot serve `legislation_documents`. Only `reconciliation-plan.ts` is
   schema-agnostic (it works off the `SourceReconciliation` interface). Reuse
   `reconciliation-plan.ts`; build a small legislation census instead of
   porting the engine (slice 2).
4. **Corpus index has no version fields.** `corpus-index-config.ts:249`
   declares only `status`, `effective_date`, `eli` for the `legislation`
   family, and `corpus-index.ts:82` `buildDoc` reads `versionValidFrom` solely
   to derive `year` (line 102); `versionValidTo` is not even selected. The
   in-flight `version_valid_from/to` fast fields are a prerequisite of slice 4,
   not a given.
5. **`FAMILY_DOC_MAPPING_MODE.legislation = "lenient"`** with an explicit
   comment that it stays lenient *until legislation has a census*. Slice 2's
   census is what unlocks flipping it to `strict`.

### DocumentAst: extend, do not fork

`packages/legal-ast/src/document-ast.ts` fits statutes except for depth and
roles. Measured on the live Slov-Lex consolidation of Trestný zákon
(`https://static.slov-lex.sk/static/SK/ZZ/2005/300/20260818.portal`, 200,
2,865,243 bytes, 2026-08-18) the container census is `cast` 3 → `hlava` 17 →
`diel` 44 → `oddiel` 4 → `skupinaParagrafov` 79 → `paragraf` 528 → `odsek`
1565 → `pismeno` 1793 → `bod` 4: **six container levels above §**, against
`HeadingBlock.level: 1 | 2 | 3`. `ParagraphRole` is a closed case-law
picklist (`holding`, `signature`, …) with nothing for a statute provision.

Decision: widen `level` to `1|2|3|4|5|6` and add statute roles
(`provision`, `subsection`, `point`, `annex`, `footnote`) to
`ParagraphRole` — additive within `version: 1`, both the valibot
`blockSchema` and `persistedDocumentAstSchema` accept older payloads
unchanged. Web touchpoint:
`apps/web/src/features/case-law/components/case-viewer/decision-text.tsx:426`
builds `` `h${block.level}` `` (h4–h6 are valid) but its class map at 431–435
covers levels 1–3 only. A separate AST package is not justified.

## Source facts (re-verified 2026-08-18)

- Slov-Lex catalog `GET https://api-gateway.slov-lex.sk/vyhladavanie/predpisZbierky/rozsirene?rows=2&start=0`
  → 200, `numFound: 26544`; docs carry `iri, cislo, nazov, rocnik, typPredp,
  typPredp_value, vyhlaseny, ucinnyOd, zodpovedajucaUcinnost` (`ucinnyDo`,
  `nadpisy` absent when empty — treat as optional).
- Temporal resolver `.../predpisZbierky/znenie?zodpovedajucaUcinnost=2026-08-18&predpis=/SK/ZZ/2005/300`
  → `{"numFound":1,"docs":[{"iri":"/SK/ZZ/2005/300/20260818"}]}`.
- The `.portal` fragment **embeds its own version history**: 60
  `tr.effectivenessHistoryItem` rows in the same document, so per-Expression
  enumeration needs no extra request. It also marks amended provisions
  (`class="odsek Skupina modified"`), carries 546 `citacnyOdkazJednoduchy`
  cross-references, 83 `div.text2` continuations (render **after** lettered
  children), and `priloha`/`poznamka` blocks.
- eSbírka `https://opendata.eselpoint.gov.cz/datove-sady-esbirka/` → 200, and
  publishes plain `.json.gz` alongside `.jsonld.gz` for datasets 001–018.
  `003PravniAktZneniFragment.json.gz` is `content-length: 1249883862`
  (1.16 GiB gz), `last-modified` 2026-08-18 02:48 UTC — refreshed daily.
  `001PravniAktZneni.json.gz` is 177,243,457.
- Licensing: SK public domain per Autorský zákon 185/2015 §5; CZ per
  121/2000 §3. **Sign-off gate:** both source rows must set
  `descriptor.allowsRedistribution` deliberately — `redistribution.ts` treats a
  null descriptor as redistributable, so an unset descriptor publishes by
  default. zakonyprolidi.cz is out of bounds (robots forbids bots).

## Slices

**0 — Legislation adapter framework (2 agent-days).**
New `apps/api/src/lib/legal-search/legislation-ingestion-types.ts`:
`LegislationSourceAdapter` + `defineLegislationAdapter`, mirroring
`ingestion-types.ts:467` (`Result<LegislationSyncPage, AdapterFetchError>`,
`minRequestIntervalMs`, `pageTimeoutMs`, `getTotalCount`, `reconciliation`).
Add `sourceRaw`/`sourceRawContentType`/`rawHash` to
`LegislationDocumentInput`; persist raw via the existing corpus-storage write.
Registry `apps/api/src/handlers/legislation/ingestion/adapter-registry.ts`
typed `Record<LegislationAdapterKey, …>` so a key without an adapter is a
compile error (mirror of `adapters/adapter-registry.ts`). Reuse
`fetchWithTimeout` (`apps/api/src/lib/fetch.ts`), `fetchWithRetry`
(`adapters/retry.ts`), `restrictOutboundUrl`. Delete the `LegislationAdapter`
stub and point `runLegislationIngestion` at the new type.
*Tests:* registry totality (declared keys == registered adapters, both
directions); a `sourceRaw` round-trip; mutation check — dropping the
`restrictOutboundUrl` call makes an off-host document URL test fail.
*Acceptance:* `runLegislationIngestion` has a caller and a typed adapter.

**1 — SK Slov-Lex adapter + `.portal` parser (4 agent-days).**
`handlers/legislation/ingestion/adapters/sk-slovlex.ts` +
`parsers/slovlex-portal.ts`. Curated Works: 300/2005, 40/1964, 513/1991,
311/2001, 160/2015; resolve each through `znenie?zodpovedajucaUcinnost=today`,
fetch `{versionIri}.portal`, parse to `DocumentAst` — headings for
cast/hlava/diel/oddiel/skupinaParagrafov/paragraf (label from the sibling
`*Oznacenie` div, heading text from `*Nadpis`), paragraphs for
odsek/pismeno/bod with statute roles, `anchorId` from the source ids
(`paragraf-N`, `paragraf-N.odsek-M.pismeno-x`). Reorder `div.text2` after
lettered children. Drop `paragraf` blocks without ids (navigation chrome).
`minRequestIntervalMs: 750`. Fixture: one committed `.portal` capture per
curated act under `__fixtures__/legislation/`.
*Tests:* structural invariants over the fixture corpus — every § anchor unique
and monotonic; no `div.text` content lost (concatenated `plainText` length ≥
stripped-HTML length minus label text); `text2` ordering asserted with a
fixture that *fails* under source order (assert the differing order first);
`hasUsableAst` true for every fixture.
*Acceptance:* the five acts read end to end at
`GET /legislation/corpus/:documentId` with a populated structure margin, and
are hit by `POST /legislation/corpus/search`.

**2 — SK history + catalog breadth + census (3 agent-days).**
Enumerate every `tr.effectivenessHistoryItem` per curated Work into one row per
Expression (`versionValidFrom` = `data-ucinnostod`, `versionValidTo` =
`data-ucinnostdo`, `status` `current` when open-ended else `historical`). Then
walk `rozsirene` with `start`/`rows` as the cursor for breadth, and the RSS
feed (`https://vyhladavanie.slov-lex.sk/rss/predpisZbierky`) as the incremental
trigger. `getTotalCount` returns `numFound`. New census CLI
`apps/api/src/scripts/legislation-census.ts` (model:
`apps/api/src/scripts/eu-ecj-census.ts`) comparing catalog `numFound` and
per-Work Expression counts against `legislation_documents`.
*Tests:* half-open window invariant — for one Work, the Expression windows
tile without gap or overlap and exactly one has `version_valid_to IS NULL`;
`start`-cursor pagination reaches the last row rather than stopping at a page
boundary; census reports a deliberately deleted row as missing (mutation
check).
*Acceptance:* census difference is reported, not silent; flip
`FAMILY_DOC_MAPPING_MODE.legislation` to `strict`.

**3 — CZ eSbírka over the bulk dumps (5 agent-days).**
`adapters/cz-esbirka.ts`. Stream `002PravniAkt` (Works) and
`001PravniAktZneni` (Expressions, `datumUcinnostiZneniOd/Do`, `TypZneni`
→ `status`) with Bun's gunzip + a streaming JSON parser; never
`JSON.parse` a whole dump. **Do not stream 003 blind:** first land a probe
that reads the leading N MB and reports record shape and per-act fragment
counts, then decide between a filtered single pass (curated acts only) and a
disk-backed index keyed by version id. Fragment tree → `DocumentAst` via
`kodTypuFragmentu` + `hloubka` (heading level) and `oznaceniUzlu` (label);
`eli`/`staleUrl` become `anchorId`/`sourceUrl`. Cursor = dump
`last-modified` + record offset.
*Tests:* fragment-tree → AST on a committed extract of 89/2012 (depth from
`hloubka`, not inferred); a memory ceiling assertion on the streaming parser
over a synthetic multi-GB stream; `TypZneni` → status map is
`as const satisfies Record<…>` against the 014 codelist so a new code fails
typecheck.
*Acceptance:* the six curated CZ codes ingest with correct validity windows;
peak RSS stays bounded.

**4 — `asOf` search, reader, web hooks (3 agent-days).**
Add `version_valid_from`/`version_valid_to` to `FAMILY_FIELDS.legislation`
(`corpus-index-config.ts:249`) and to `buildDoc`
(`handlers/legislation/corpus-index.ts:82`) if the in-flight PR has not
landed. Add `asOf` to `searchLegislationBodySchema` (`search.ts:~52`), to the
pg filter block (~118), the corpus query builder (~199), **and the rehydration
filters (~285)** — a stale index copy must not satisfy a window it no longer
matches. Reader: `GET /legislation/corpus/:documentId` gains a sibling
`GET /legislation/corpus/work/:eli?asOf=` resolving Work + date → Expression.
Widen `HeadingBlock.level` and `ParagraphRole` in
`packages/legal-ast/src/document-ast.ts`; extend the class map in
`decision-text.tsx:431`. Web needs: a statutes list and a
`/law/$country/statutes/...` reader under `public-law-shell.tsx`, an as-of
date control, a version-history switcher, deep links to `#paragraf-N`, and
`FEATURE_PUBLIC_LAW` gating. No web implementation detail here.
*Tests:* `asOf` boundary property — for a date on a window edge exactly one
Expression matches (half-open, `from <= d < to`); parity test that the pg and
corpus-index paths return the same id set for the same `asOf`; mutation check
by removing the rehydration filter.

**5 — Cross-references (design only, 3 agent-days when scheduled).**
`legislation_citations` keyed `(citing_document_id, target_eli,
target_provision_anchor)` pointing at **Works**, not Expressions, so a link
survives re-consolidation. Sources: SK `a.citacnyOdkazJednoduchy` (546 in one
act), CZ `odkazyZFragmentu` and dataset `008PravniAktOdkaz`. Feeds
`citation_authority`, which `search.ts` already blends. Not scheduled with
slices 0–4.

## Risks

- **eSbírka 003 is 1.16 GiB gz and reported non-streamable.** Slice 3 is
  gated on the probe; the fallback is curated-acts-only until the REST API key
  (datová schránka, ~10 days) arrives.
- **Slov-Lex `api-gateway` is undocumented.** Contract-shape tests over
  committed captures plus `getTotalCount` are the drift detector; a shape
  change must fail a test, not silently zero the crawl.
- **HTML vocabulary drift.** The class census above is committed as a fixture
  assertion so a new container class fails rather than being dropped.
- **Licensing sign-off** before either source row is marked redistributable.
