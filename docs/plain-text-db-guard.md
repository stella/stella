# Plain-text database guard

Migration `20261003123100_plain_text_markup_guard` installs `BEFORE INSERT OR
UPDATE OF` triggers. Inserts check every guarded value; updates check only
values that changed (`IS DISTINCT FROM`). An unchanged legacy markup value
therefore cannot block indexing, counter updates, or repair of another column.
A `CHECK NOT VALID` would check the whole resulting row on every update and
would break those operations. Installation performs no validation scan, table
rewrite, backfill, or index build.

The SQL predicate `plain_text_has_markup(text)` uses the verbatim
`TAG_LIKE_MARKUP_SOURCE` from `apps/api/src/lib/case-law/plain-text-markup.ts`.
The real-Postgres property test compares both engines and the installed SQL
function. HTML attribute whitespace is space, tab, LF, FF, or CR; NBSP and BOM
are text. Comparisons such as `a < b`, `§ 5 < 3`, and `i<5 and j>2` remain text.
An expression shaped exactly like a tag with boolean attributes (`a<b and c>d`)
is necessarily treated as markup. RTF control sequences and entity decoding
belong to the write-time sanitizer; this guard detects tag-like markup.

The 42 guarded columns come from the case-law and legislation schema owners:

| Table                           | Columns                                                                                                                                                   | Reason                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `case_law_decisions`            | `case_number`, `citation_key`, `ecli`, `court`, `court_id`, `decision_type`, `metadata`                                                                   | Primary and normalized references, court labels, classification text, and publisher metadata values. |
| `case_law_decision_supplements` | `case_number`, `court`, `metadata`                                                                                                                        | Supplement references, court labels and metadata values.                                             |
| `case_law_decision_identifiers` | `value`, `normalized_value`                                                                                                                               | Original and normalized citable references.                                                          |
| `case_law_judges`               | `court`, `full_name`, `name_key`, `portrait_attribution`                                                                                                  | Court and person labels, normalized name, and plain-text image credit.                               |
| `case_law_decision_judges`      | `name_as_printed`, `name_key`                                                                                                                             | Publisher-printed judge labels and normalized matching keys.                                         |
| `case_law_citations`            | `citation_text`, `citation_key`, `normalized_identifier_value`, `cited_court_hint`, `cited_sheet_number`                                                  | Printed and normalized citation text and extracted court/file labels.                                |
| `case_law_provision_citations`  | `work_identifier`, `work_collection`, `section_suffix`, `subsection`, `letter`, `point`, `sentence`, `print_text`, `name_text`, `printed_work_identifier` | Printed statute identifiers, provision labels and display names.                                     |
| `legislation_documents`         | `title`, `document_type`, `metadata`                                                                                                                      | Official title, classification text, and publisher metadata values.                                  |
| `legislation_work_names`        | `official_title`, `derived_name`, `cited_key`, `match_key`                                                                                                | Official and derived names and their text matching keys.                                             |
| `case_law_search_documents`     | `title`                                                                                                                                                   | Search result titles.                                                                                |
| `legislation_search_documents`  | `title`                                                                                                                                                   | Search result titles.                                                                                |

Metadata validation traverses JSON string values recursively, including arrays;
it does not treat object keys or JSON escaping as document markup. Case-law
metadata exempts exactly the URL string leaves declared by its source adapter.
The migration's SQL contracts are generated from `METADATA_URL_SCHEMAS` and
`composedMetadataUrlSchema`; an ungated test binds every generated contract to
these owners. Decision metadata also includes the declared supplement URLs;
supplement metadata uses the adapter's original contract. Source identity comes
from `case_law_sources`, and changing a row's `source_id` rechecks metadata.
Unknown sources, undeclared paths, sibling labels, and unexpected objects or
arrays remain guarded. URL spelling is preserved. Legislation metadata has no
URL declaration and retains full string-leaf validation. Changing a
metadata column checks its entire new value. Existing markup must be repaired
before changing that column, but unrelated column updates remain available.
Full decision/legislation text, supplement bodies, searchable text, preview
passages, and citation sentence evidence are excluded: legal prose may contain
literal tag-shaped text such as `Before <quoted> after`. Quoted attributes
containing `<` or `>` still count as markup in labels and metadata.
Raw source, URLs, object-storage keys, structured ASTs, and enum/status fields
retain their own storage contracts.

## Error contract

A rejected write raises PostgreSQL SQLSTATE `23514` (`check_violation`) with:

- Message: `plain_text_markup_rejected`.
- Constraint: `plain_text_no_markup`.
- Schema, table, and column: the affected database identifiers.

These structured fields distinguish this parser defect from other constraint
violations. Ingestion should classify it as an item-level parser failure and
record the affected item through its existing failure path. Retrying unchanged
input cannot repair it; the parser must emit plain text. The error never includes
the rejected value. This change defines the database contract; ingestion error
routing consumes it separately.
