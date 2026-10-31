# sk-us publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`sk-us`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: decision month; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: numFound from the official DMS search for docType USSR_DECISION_MK.
- Integration constraint: A 204, wholly refused range, or malformed response is unverified, never zero. Do not mix the separately published ZNAU collection into the denominator.

### Publisher-index-first check

GET [https://www.ustavnysud.sk/](https://www.ustavnysud.sk/); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `fbdf9120b7046776488dcf82f02a971886d62d5a81c1a14df6f9a0d5d32589b5`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
