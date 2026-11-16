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

## Historical raw document coverage

Object-aware replay reads a stored envelope and its retained document objects.
The document-object hooks return `status: "metadata-only"` when required
stored document input is missing. Replay does not contact the publisher.
Capture changes apply to subsequent document fetches.

The following source histories establish missing document input. They describe
stored shapes and capture paths, not measured historical row counts.

| Source      | Historical input requiring additional capture                                                                                   | Possible later capture                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sk-courts` | Listing/detail/registry metadata without the deferred PDF.                                                                      | Fetch the stored document URL through the existing gated document downloader; retain the PDF through the raw-object owner. At least one document request per row.             |
| `pl-kis`    | PDF-endpoint bodies omitted after an unsuccessful parse, including successful responses that were not PDFs.                     | Use the stored EUREKA ID to request `/api/public/v1/informacje/{id}/eksport/PDF`; retain the body before parsing. At least one document request per row.                      |
| `cz-nss`    | Older rich-HTML parse failures retained fallback text without the original HTML (before the rich-response retention change).    | Request `/DokumentOriginal/Html/{documentId}` using the stored identity. At least one document request per row; fallback text cannot reconstruct the original rendition.      |
| `sk-us`     | Legacy `application/json` search-only rows without XHTML or PDF.                                                                | Request DMS content and `/docDownload/{documentId}` using the stored document ID; retain both. At least two document requests per row, plus any required metadata enrichment. |
| `eu-ecj`    | Early rows stored before document parsing retained neither the XHTML nor an AST, as documented in the case-law ingestion guide. | Resolve the stored CELEX and language through the existing Cellar flow and capture verbatim XHTML; document and resolution requests depend on the retained URLs.              |

Legacy `sk-us` PDF-only rows already retain the PDF bytes but lack the XHTML
required by the current parser and may lack their listing metadata. They also
remain metadata-only until the missing input is captured. Successfully fetched
`cz-uohs` and `pl-uokik` files are already archived as objects; replay can read
those objects without further publisher access.

Other sources can have listing-only rows after absent, refused or unavailable
document reads. A legacy wrapper can also retain the primary document while
lacking listing metadata or an alternate rendition. Neither case establishes
that a successfully fetched primary document was omitted.

Any later capture is a separate, explicitly authorized operation. Its row
selection, request volume, publisher availability and access policy must be
assessed then. This inventory starts no capture or replay job.
