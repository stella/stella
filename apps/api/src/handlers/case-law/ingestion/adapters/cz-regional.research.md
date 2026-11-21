# cz-regional publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`cz-regional`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `listing-enumerated`.
- Natural reconciliation axis: publication day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: The yearly open-data index states monthly pocet; the daily feed currently exposes totalPages to the reconciliation reader.
- Integration constraint: Keep daily enumeration distinct from a publisher-stated monthly count. Do not infer an exact count from page count times page size. Publication year differs from decision year.

### Publisher-index-first check

GET [https://rozhodnuti.justice.cz/api/opendata/2026](https://rozhodnuti.justice.cz/api/opendata/2026); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **live count field verified**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `2ca212f334c2e01b343acbe61db390a4918efe10b4ef0a4f9f0206feaa7af47d`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
