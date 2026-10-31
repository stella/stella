# pl-sn publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-sn`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `listing-enumerated`.
- Natural reconciliation axis: decision day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: The adapter records that the current search API exposes rows and continuation, without a result total.
- Integration constraint: Terminate only on the verified short/empty page. Absence of a live count remains unverified in this pass because the publisher denied access; do not claim live none-found.

### Publisher-index-first check

GET [https://sn.pl/pl/wyszukiwarka-orzeczen](https://sn.pl/pl/wyszukiwarka-orzeczen); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 403.
Evidence status: **unverified: HTTP Error 403: Forbidden**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
