# Case-law ingestion

## Parser versions and re-parse scopes

`PARSER_VERSIONS` in
`apps/api/src/lib/legal-search/ingestion-constants.ts` is the runtime
parser-version contract. Its companion in
`apps/api/src/lib/legal-search/parser-reparse-scopes.ts`,
`PARSER_VERSION_SCOPES`, declares what replaying each version must recompute. An
`all` scope covers every parser-owned value and records why a full re-parse is
needed. A `features` scope limits the re-parse to its named stored decisions.

Feature-scoped replay is valid only after each feature has dedicated storage
and existing rows have been backfilled. Register that table, column or JSONB
path, storage state, and backfill state in `PARSER_REPARSE_FEATURES` in
`apps/api/src/lib/legal-search/parser-reparse-scopes.ts` first. The
compiler rejects version mismatches, unknown features, and features that are
not both stored and backfilled.

The version guard follows value imports from every registered parser to find
the files that can affect output. `PARSER_OUTPUT_BOUNDARIES` in
`scripts/check-parser-versions.ts` is the reviewed exception list for logging,
telemetry, configuration, and connection setup. Traversal neither owns a
boundary module nor continues through it. Boundary entries must exist and
cannot be placed in adapter, parser, case-law, legal AST, text-normalization,
hashing, or parser-version modules.
