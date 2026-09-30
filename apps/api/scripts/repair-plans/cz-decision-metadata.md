# Czech decision metadata repair

The NS parser emits typed complaint cells: `date` (ISO `value`), `text`, or
`unresolved-date`. Each cell retains the official `sourceValue` verbatim;
`defects` identifies repeated values, conflicting dates, and invalid dates.
No date is inferred from the decision body, linked decision, or docket.
The raw source and the related-proceedings AST table remain unchanged.

## Offline dry run

An operator exports bounded batches of at most 1,000 NS rows, ordered by stable
row ID, with `id`, `adapterKey: "cz-ns"`, `sourceHash`, `metadata`, and `printHtml`
(one JSON object per line). `printHtml` must be the archived print response,
including the `#box-table-a` metadata table: use the `print` part of the stored
source envelope, or a verified legacy print payload. Do not use fulltext or
fetch fresh court pages. Store exports and output outside the public repository.

From `apps/api`, run:

```sh
bun scripts/repair-plans/cz-ns-complaints-dry-run.ts < archived-rows.jsonl > proposals.jsonl
```

The script has no database/network client and no write/apply mode. It emits
only a before/after proposal for the complaint field; a missing source table
produces `unresolved` and preserves the existing value. Review every flagged
cell and missing archive before authorizing any repair. A normalized value
represents only the spelling of the date NS states, not a correction of that date.

## Applying later, after separate approval

Keep a ledger of IDs, captured source hashes, before/after fields, and outcomes.
Any future writer must compare the current source hash and complaint field
with the dry-run snapshot before updating only that metadata key; skip stale
rows. Preserve other metadata and raw archives, use bounded transactions, and
record applied/unchanged/unresolved outcomes before advancing the cursor.
Reapplying an approved proposal must converge to the same value. A wholesale
re-ingestion is unnecessary and may overwrite unrelated fields.

For ÚS, the adapter now sets `documentUrl` when it parses a document page.
A future repair may propose `sourceUrl` only for successfully parsed document
rows whose URL targets the official `Search/GetText.aspx` endpoint and whose
`documentUrl` is null. Listing-only, quarantine, and result-card URLs must stay
excluded. Review a separate offline export; compare source hash, URL, and null
value before applying. No existing rows are written by this change.
