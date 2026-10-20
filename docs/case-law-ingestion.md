# Case-law ingestion

## Parser versions and re-parse scopes

`PARSER_VERSIONS` is the runtime parser-version contract. Its companion
`PARSER_VERSION_SCOPES` declares what replaying each version must recompute. An
`all` scope covers every parser-owned value and records why a full re-parse is
needed. A `features` scope limits the re-parse to its named stored decisions.

Feature-scoped replay is valid only after each feature has dedicated storage
and existing rows have been backfilled. Register that table, column or JSONB
path, storage state, and backfill state in `PARSER_REPARSE_FEATURES` first. The
compiler rejects version mismatches, unknown features, and features that are
not both stored and backfilled.
