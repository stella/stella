# cz-us publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`cz-us`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: decision year; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: reported from the NALUS results page (the adapter reads the z celkem total).
- Integration constraint: Reuse the year search already submitted. Search form HTML alone does not establish a count.

### Publisher-index-first check

GET [https://nalus.usoud.cz/Search/Search.aspx](https://nalus.usoud.cz/Search/Search.aspx); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `00d1f228a2ffd1e97a6684b9b0c3fc1c94209afeb4016fe23f807547ec263cea`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
