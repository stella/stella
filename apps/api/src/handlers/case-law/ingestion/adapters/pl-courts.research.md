# pl-courts publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-courts`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: decision day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: info.totalResults on the SAOS search response.
- Integration constraint: The benchmark is SAOS holdings, which contain several courts and have different freshness from the courts own portals; it is not all Polish judgments.
- Scope status: `partial-publisher`. The dump accepts records without a usable
  judgment date, while reconciliation queries only decision days. The bounded
  search cannot enumerate records outside those dates; no undated reconciliation
  slice exists. Census observations for measured dates must not authorize a
  complete-source verdict. See `pl-courts.ts` (`dumpRequest` and
  `listPlCourtsDayPage`).

### Publisher-index-first check

GET [https://www.saos.org.pl/api/search/judgments?pageSize=1&pageNumber=0](https://www.saos.org.pl/api/search/judgments?pageSize=1&pageNumber=0); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 406.
Evidence status: **unverified: HTTP Error 406: Not Acceptable**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
