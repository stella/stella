# cz-ns publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`cz-ns`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: publication day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: @toplevelentries on the Domino view; day search also states matched/shown counts, except a singleton.
- Integration constraint: Keep the 900-result window refusal. A single-result day can use its completed listing enumeration. The publisher contains selected decisions of other courts too.

### Publisher-index-first check

GET [https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch?ReadViewEntries&Count=1&Start=1&OutputFormat=JSON](https://rozhodnuti.nsoud.cz/Judikatura/judikatura_ns.nsf/WebSearch?ReadViewEntries&Count=1&Start=1&OutputFormat=JSON); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **live count field verified**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `c315b9c9a4ce600e179ec643e6f1c727e57be0bc4462accc308c24e51651335a`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
