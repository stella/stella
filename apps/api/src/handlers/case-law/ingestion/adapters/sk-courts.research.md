# sk-courts publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`sk-courts`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: decision day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: numFound from the official JSON decision listing.
- Integration constraint: Reuse the existing day response. Request pages are one-based while the response echoes a zero-based page; the existing adapter handles this.

### Publisher-index-first check

GET [https://obcan.justice.sk/pilot/api/ress-isu-service/v1/rozhodnutie?page=1&size=1](https://obcan.justice.sk/pilot/api/ress-isu-service/v1/rozhodnutie?page=1&size=1); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **live count field verified**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `9266ac79a38e05b9c9fdf636161dcbfbf7021ee687bd0cd5594770b1915db7d0`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
