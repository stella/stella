# pl-kis publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-kis`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: issue month plus undated; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: totalHits on Eureka public search.
- Integration constraint: Preserve the category filter, result-window refusal, and explicit undated slice. The all-minus-dated operation must remain in a consistent observed window.

### Publisher-index-first check

GET [https://eureka.mf.gov.pl/](https://eureka.mf.gov.pl/); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `894ee11f7f9ee24cf9dc7cf39ee33e9747b8cece4c1200d93700b9a529b29be3`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
