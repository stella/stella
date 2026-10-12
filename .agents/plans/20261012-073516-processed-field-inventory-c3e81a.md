# Plan: Processed-field inventory for case-law sources

## Goal

Every case-law source states, for every field of the parsed decision we rely
on, either that it provides it (and where) or why it does not — with a closed
reason code, a written justification and recorded evidence. A missing
disposition fails typecheck; a disposition the recorded documents contradict
fails the conformance suite. This is the processed-level counterpart of the
raw `SourceAdapter.sourceFields` inventory.

Court paragraph numbers are the first member (slice 1). The field family
below is agreed; `outcome` and `cited-provisions` get a typed contract in the
scalars slice.

## Current State

- Raw level is covered: `sourceFields` / `sourceSurfaces` are required on
  `SourceAdapter` (`apps/api/src/lib/legal-search/ingestion-types.ts`), with
  `excludedSourceField(reason)` constructors and registry-wide suites
  (`source-field-inventory.test.ts`, `source-surface-census.test.ts`,
  shrink-only `source-surface-backlog-baseline.json`).
- Processed level is not: AST facts are free optionals
  (`ParagraphBlock.number`, `role`, `note`, `listDepth`, page anchors, inline
  citations in `packages/legal-ast/src/document-ast.ts`) and row facts are
  untyped metadata keys. Nothing obliges a parser to fill them or say why
  not. Paragraph numbers showed the cost: three sources filled `number`; the
  four Czech parsers either left the marker in the text (NS) or removed it and
  dropped the value (NSS, ÚS, regional), so `#par=` links never resolved.

## Decisions

- **One central total map, keyed by source registration key.** The unit is
  the source, not the parser: the eleven RIS adapters share one parser yet
  could differ in what their courts print, and the CourtListener importer is
  a source without a `SourceAdapter`. `PROCESSED_FIELD_INVENTORY` in
  `apps/api/src/lib/legal-search/processed-field-inventory.ts` is
  `satisfies Record<AdapterKey | ImportSourceKey, Record<ProcessedFieldId,
  ProcessedFieldDisposition>>`, so a new source or a new field without a
  disposition does not compile; the suite also asserts its keys equal the
  live registry. Alternative rejected: a required field on `SourceAdapter`
  (leaves importers out, scatters the reviewed table across 30 files).
- **Dispositions only through constructors** (`providedField(how, evidence)`,
  `skippedField(reason, justification, evidence)`), with a module-private
  symbol and a compile-time non-blank check, the same discipline as
  `excludedSourceField`.
- **Closed skip reasons.** Facts: `source-lacks`, `publisher-removes`.
  Debts (legacy only, listed in `processed-field-backlog-baseline.json`,
  which only shrinks): `not-extracted`, `unassessed`.
- **Evidence is recorded publisher bytes** (`recordedEvidence(paths…)`),
  read by the source's own parser through a total reader map
  (`apps/api/src/tests/helpers/processed-field-evidence.ts`). A claim with no
  recording yet is `unrecordedEvidence(reason)` and is a baseline line too.
  Factual skips must carry a recording.
- **Per-field check functions** in `processed-field-inventory.test.ts`
  (`PROCESSED_FIELD_CHECKS`, total over the field list): `provided` must show
  in the parsed recording; a factual skip must not be contradicted; a
  `not-extracted` skip with a recording must still show the field in the
  text, so fixing the parser forces the declaration to change.
- **Paragraph numbers: the number moves into structure** (Hungarian
  precedent; the reader renders `number` as gutter chrome and
  `paragraph-range.ts` resolves it). One shared extractor,
  `parsers/court-paragraph-numbers.ts`, runs as the last step of the CZ NS,
  NSS, ÚS, regional, SK ÚS and SK courts parsers. It accepts `[N]`, `N.`,
  `N)` only when the decision's body paragraphs read as one numbering
  (counting from 1, nested lists restarting beside it, density and lead-in
  bounds, small skips/repeats kept as printed); implausible numbering is
  rejected with a typed defect (`irregular-sequence`, logged as
  `case_law.ingestion.paragraph_numbering_rejected`) and the markers stay in
  the text.

## Paragraph-number projection (proposal)

Consumers that need only the numbers must not load the AST. A chat citation
stamper that numbers cited decision passages would otherwise select
`ast_s3_key` through `withRedistributableDecisions` and read every cited
decision's whole AST from object storage to keep a few dozen anchor → number
pairs.

- **Where:** a nullable `court_paragraph_numbers jsonb` column on
  `case_law_decisions`, shape `{ "v": 1, "anchors": string[], "numbers":
  number[] }` (parallel arrays, document order). `NULL` = not projected (row
  not re-parsed since the column exists, or no AST); an empty projection =
  parsed and unnumbered. Rejected: a `(decision_id, number, anchor_id)`
  table — ~30 rows per decision across the whole corpus (order of 10^8) for
  a lookup that is always per decision and never across decisions; the
  column is read with the row the gate already selects, worst case a few KB
  (TOAST).
- **Written by every path that writes the AST pointer**, in the same
  statement as `ast_s3_key`/`content_hash`, from the shared resolver
  (`courtParagraphNumbersByAnchor` in `@stll/legal-ast/court-paragraph-number`):
  the ingestion upsert (corpus mirror compared columns), stored-raw replay
  apply, deferred document processors (SK courts PDFs), EU completion, and the
  SK document backfill. Erasure/redaction nulls it with the other content
  columns (extend the redacted-row check constraint).
- **Covered by the conformance suite:** the `court-paragraph-numbers` check
  gains a pipeline-level assertion that the persisted projection equals
  `courtParagraphNumbersByAnchor(ast.blocks)` for each source's recording, so
  a write path that forgets it fails.
- **Rollout:** additive migration (nullable column, no default, lock/statement
  timeouts set); the replay re-parse of the six bumped sources fills it; a
  projection-only bounded backfill (read AST from object storage, write the
  column, cursor-paginated in the maintenance lane, load-gated) fills current
  rows of the other numbered sources (eu-ecj, hu-bhgy, pl-tk).
- **Follow-up:** switch `loadCourtParagraphNumbers` to select the column
  (no AST read); `NULL` reads as "no number" — no fallback path to remove
  later. Lands after the backfill reports zero `NULL` rows for numbered
  sources.

## Seed fixtures without raw

Seeded decisions are snapshots and may hold no raw source (e.g. the flagship
`27 Cdo 59/2022` row planned for `cz-ns.json.gz`, from a public export).
Re-parsing recorded fixtures on a parser/AST version change belongs to one
fixture re-parse generator, which re-normalizes rows without raw from their
stored text/AST and never re-stamps analysis fingerprints. Slice 1 adds no
second tool; it is shaped to be picked up by that generator:

- The paragraph-number step is a pure function over classified blocks,
  `extractCourtParagraphNumbers(blocks)` in
  `parsers/court-paragraph-numbers.ts`, run as the last step of every parser
  that provides numbers. A stored AST is exactly such blocks, so the generator
  re-normalizes a raw-less row by running it over `document_ast.blocks` for
  sources whose inventory disposition is `provided` (the same function, so the
  output equals a re-parse for that step).
- It is idempotent (property test) and leaves an already numbered decision
  untouched, so re-running the generator is a fixed point.
- Moving a marker changes the analysis input: rows whose text changes need
  their analyses regenerated or re-stamped by a person, as the generator
  intends.
- A raw-less snapshot whose old parser removed the marker and dropped the
  number cannot be recovered from itself. The cz-nss, cz-us and cz-regional
  seeds on this branch were refreshed once (outside the repo) from recordings
  of the publishers' documents, numbers matched to stored blocks by text;
  cz-ns, sk-us and sk-courts seeds by the extractor over stored blocks.

## Field family

Processed level, derived from the AST, the decision row and their readers.
Shape: S = per-decision scalar/list, B = block structure, I = inline.

| id | what / where | shape | main consumer |
|---|---|---|---|
| `court-paragraph-numbers` | `ParagraphBlock.number` | B | reader gutter, `paragraph-range.ts`, citations |
| `case-number` | `caseNumber`, AST `metadata.caseNumber`, role `case-number` | S | `decision-caption.ts` |
| `ecli` | `ecli` | S | `decision-row-columns.ts` |
| `court` | `court` / `courtId` | S | caption, `analysis-prompt.ts` |
| `decision-date` | `decisionDate` | S | facets, caption |
| `decision-type` | `decisionType` | S | `analysis-prompt.ts`, type filter |
| `judges` | `result.judges[]` with roles (rapporteur, presiding, panel, dissenting) | S | `judges/decision-judges.ts` |
| `publisher-summary` | `textFields` headnote / legal sentence / abstract, or summary roles | S/B | `publisher-summary.ts`, reader |
| `keywords` | `metadata.keywords` (+ fallbacks) | S | `decision-row-columns.ts`, MCP results |
| `cited-provisions` | `metadata.statutes` / AST `metadata.statutes` | S | none typed yet (see gaps) |
| `outcome` | `metadata.outcome` | S | none yet (see gaps) |
| `publisher-cited-cases` | `publisherCitedCases` | S | `pipeline/decision-plan.ts` |
| `decision-title` | heading role `decision-title` | B | `decision-text.logic.ts` |
| `section-headings` | heading role `section-heading` | B | outline rail, `sections-from-ast.ts` |
| `operative-part` | paragraph role `holding` | B | reader, `sections-from-ast.ts` |
| `dissent` | paragraph role `dissent` | B | reader, citation extractor |
| `bench-blocks` | roles `panel`, `counsel`, `parties`, `signature`, `closing` | B | reader |
| `footnotes` | blocks with `note.noteId` | B | reader |
| `page-anchors` | inline `page-anchor` | I | reader, citation pinpoints |
| `inline-citations` | inline `citation` | I | citation extractor |

Dropped from the family: `sections` (derived for every source by
`segmentDecision` fallback) and `document-role` (two sources; belongs with
identity). Reasoning text itself is the document, not a field.

## Per-source table

Paragraph numbers (implemented; evidence = recordings the suite parses):

| source | disposition | evidence |
|---|---|---|
| cz-ns | provided (shared extractor) | `cz-ns-page.json.gz` (40 decisions: `[N]`, `N.`, `N)` styles; skip in 5 Tdo 28/2024 kept) |
| cz-nss | provided (was: stripped and dropped) | `cz-nss-10-as-124-2025.html.gz`, `cz-nss-22-as-35-2026.html.gz` (new recordings) |
| cz-us | provided (was: stripped and dropped) | `cz-us-iv-us-422-26.html.gz`, `cz-us-iii-us-2429-24.html.gz` (new), `cz-us-page.json.gz` (1993, unnumbered) |
| cz-regional | provided (was: stripped and dropped) | `cz-regional-finaldoc-{district,appellate}.json.gz` |
| sk-us | provided (was: left in text) | `sk-us-iii-us-265-2026.content.json.gz` (new) |
| sk-courts | provided (was: left in text) | unrecorded: no general-court PDF recorded (portal 500 on 2026-10-12) |
| eu-ecj | provided (point ids) | `eu-ecj/62022CJ0128.en.html.gz` |
| hu-bhgy | provided (`[N]`) | `hu-bhgy-decision.docx` |
| pl-tk | provided (`wyrok_akapitNr`) | `pl-tk-case-sk-14-11.html.gz` |
| pl-nsa | skipped: not-extracted | `pl-nsa-rows.json` ("1. Wyrokiem …" left in text) |
| pl-courts | skipped: not-extracted | unrecorded |
| at-findok | skipped: source-lacks | `at-findok-152649.zip` |
| at-courts … at-bks (11) | skipped: unassessed | unrecorded (no recent Supreme Court full text recorded) |
| pl-sn, pl-kio, pl-ncourt, pl-kis, pl-uodo, pl-uokik | skipped: unassessed | unrecorded |
| us-courtlistener | skipped: unassessed | unrecorded |

Rest of the family, current state from code reading (P provided, – absent;
to be turned into dispositions with evidence in later slices). Always P and
omitted: case-number, court, decision-date, decision-type, section-headings.

| source | ECLI | judges | summary | keywords | provisions | outcome | cited cases | title | operative | dissent | bench | footnotes | page anchors | citations |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cz-regional | P | P | – | P | – | – | P | P | P | – | – | – | – | – |
| cz-ns | P | – | P | P | P | – | – | P | P | – | – | – | – | – |
| cz-nss | P | – | P | P | – | P | – | P | P | – | – | P | – | – |
| cz-us | P | P | – | – | – | P* | – | P | P | P | – | P | – | – |
| sk-courts | P | – | – | – | – | – | – | P | P | – | – | – | – | – |
| sk-us | P | P | P | – | ? | – | – | P | P | – | – | – | – | – |
| pl-courts | – | P | P | P | P | – | P | P | P | – | – | – | – | – |
| pl-sn | – | – | – | – | – | – | – | P | P | – | – | – | – | – |
| pl-kio | – | P | – | P | P | P | – | P | P | – | – | – | – | – |
| pl-tk | – | P | – | – | – | – | – | P | P | P | P | P | – | – |
| pl-nsa | – | P | P | P | P | P | – | P | P | P | – | – | – | – |
| pl-ncourt | – | P | P | P | P | – | – | P | P | – | – | – | – | – |
| at-ris (11) | P | – | P | P | P | – | – | – | P | – | – | – | – | – |
| at-findok | P | – | P | P | P | – | – | P | – | – | – | – | – | – |
| eu-ecj | P | P (partial) | – | P | – | – | P | P | P | – | – | – | – | – |
| hu-bhgy | – | P | P | P | P | – | P | P | P | – | P | P | – | – |
| pl-kis | – | – | P | P | P | – | – | P | P | – | – | – | – | – |
| pl-uodo | – | P | P | P | – | – | P | P | P | – | – | P | – | P |
| pl-uokik | – | – | – | P | – | – | – | P | P | – | – | – | – | – |
| us-courtlistener | – | P | P | – | – | – | – | – | – | P | P | P | P | – |

\* stored as `metadata.rulingType`, not `outcome`.

Gaps found (source has it, processed output lacks it), first to fix:

1. pl-sn bench (full panel with roles and dissenters) only in metadata; no `judges`.
2. cz-nss rapporteur and sk-courts judge only as untyped `metadata.judge`.
3. cz-nss applied-legislation grid excluded; sk-courts `odkazovanePredpisy`
   and areas under source-specific keys; cz-us subject index and provision
   lists under source-specific keys (no keywords/provisions for cz-us).
4. pl-courts dissent texts only in metadata; sk-us has no `dissent` role.
5. eu-ecj footnotes emitted as plain paragraphs; judges limited to
   rapporteur and Advocate General; provisions always empty.
6. `outcome` (4 sources, inconsistent keys) and `cited-provisions` have no
   typed consumer: either define the contract or drop them from the family.

## Vertical Slices

1. **This branch (done):** registry, constructors, baseline, evidence
   readers, conformance suite; `court-paragraph-numbers` for every source;
   shared extractor in six CZ/SK parsers; parser versions bumped (cz-regional
   13, cz-ns 18, cz-nss 20, cz-us 25, sk-courts 17, sk-us 11); seed
   snapshots refreshed.
2. **Paragraph-number projection, one PR:** column + migration, every write
   path, conformance assertion, projection-only backfill job; then a small PR
   switching the chat stamper to the column once the backfill is complete.
3. **Scalars, one PR:** `ecli`, `judges`, `keywords`, `cited-provisions`,
   `outcome`, `publisher-cited-cases`, `publisher-summary` — checks read the
   ingestion result built from the recording (adapter-level readers rather
   than parser-level). Fixes gaps 1–3 where one-line, the rest as
   `not-extracted` baseline lines.
4. **Block roles, one PR:** `decision-title`, `section-headings`,
   `operative-part`, `dissent`, `bench-blocks` — checks over AST roles; fixes
   gap 4.
5. **Notes and inlines, one PR:** `footnotes`, `page-anchors`,
   `inline-citations`; fixes gap 5.
6. **Evidence debt, ongoing:** record a sk-courts PDF, a recent OGH RIS text,
   Polish SN/KIO/UOKiK documents; each recording deletes baseline lines.

## Contracts and Invariants

- Inventory keys = registered source keys; fields = `PROCESSED_FIELDS`.
- Baseline lists = backlog/unrecorded declarations, both directions.
- Paragraph numbers: stored value is the court's printed number; text loses
  only the marker; extraction is idempotent and never touches holdings,
  headings, notes, closings or signatures (property test).

## Verification

Bun tests: `court-paragraph-numbers.test.ts` (recordings per court),
`court-paragraph-numbers.property.test.ts`,
`processed-field-inventory.test.ts`, plus the existing parser suites.

## Rollout and Recovery

Re-parse is the existing stored-raw replay (`replay-tick`, enrolment in
`replay-enrolment.ts`, all sources `off` today; `dry-run` then `enrolled`
with a daily budget ≤ 10 000, load-gated by `REPLAY_HEALTH_CONFIG`). The
parser-version bump makes every row of the six sources eligible; no publisher
contact and no sitemap/shard scans. Text changes for cz-ns, sk-us and
sk-courts rows (marker leaves the text), so their stored AI analyses go stale
and regenerate on next open; cz-nss, cz-us and cz-regional text is unchanged
(their markers were already stripped) and their analyses stay valid.

## Open Questions

1. Replay order and budget per source (volumes: production row counts per
   source are needed; not queried from here).

Decided: the analysis prompt shows the court's paragraph number beside each
block's anchor, so analyses can cite "bod 12"; it is part of the input
fingerprint, so stored analyses of numbered sources regenerate on next open,
spread by the replay schedule. Separate follow-up PR after slice 1.
