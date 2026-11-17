# pl-ncourt publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-ncourt`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: judgment day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: XML root total on the Ministry of Justice listing.
- Integration constraint: Use the adapters actual endpoint and filters. The root probe used for research returned 404, which is not count absence. Wholly unserved ranges cannot establish a count.

### Publisher-index-first check

GET [https://apiorzeczenia.wroclaw.sa.gov.pl/ncourt-api?limit=0](https://apiorzeczenia.wroclaw.sa.gov.pl/ncourt-api?limit=0); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 404.
Evidence status: **unverified: HTTP Error 404: **. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
