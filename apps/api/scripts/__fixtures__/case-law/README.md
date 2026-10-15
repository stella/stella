# Case-law fixtures

One archive per source (`<adapterKey>.json.gz`): the source row and a few of
its decisions, seeded by `apps/api/scripts/seed-case-law.ts`.

## Provenance

Most rows are recorded verbatim from the production database: every column,
including the raw source (or its object-store key), its hash and the parser
version that produced the stored AST.

### `cz-ns`: 27 Cdo 59/2022

The flagship decision of the reader screenshots was added later, without
database access, from the public reader API
(`GET /v1/case/decisions/by-slug/27-cdo-59-2022?country=CZE`):

- **Served as is:** `id`, `source_id`, `created_at`, `updated_at`, the case
  identity, dates, URLs and the document AST.
- **Restored to the stored shape:** the public response splits stored
  metadata into `metadata` and `textFields`; each present text field is put
  back under its key. The AST's blocks carry the derivable `plainText` the
  public projection leaves out (`parseDocumentAst`).
- **Derived as the cz-ns pipeline derives them:** `fulltext` is
  `blocksToPlainText` of the AST, `sections` is `segmentDecision` of that
  fulltext, and `parser_version` is the current cz-ns parser version, so a
  reparse check sees the row as current.
- **Not available, left null:** `source_raw`, `source_raw_s3_key`,
  `source_raw_content_type` and `source_hash`. The public API never serves the
  raw publisher pages, so this row cannot be reparsed from its raw source; a
  parser change that should reach it (for example court paragraph numbers on
  the blocks) has to work from the stored AST.

Its `analysis` is generated fixture analysis, written against the production
Czech analysis prompt with no runtime model call, and checked the way
`apps/api/src/scripts/decision-analysis-save.ts` checks a submission (schema,
input fingerprint, anchors). `generatedAt` is the moment it was built. `case-law-fixture-analysis.test.ts` holds its
`inputFingerprint` to the fixture's text and the current prompt.
