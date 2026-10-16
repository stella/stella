# cz-nss publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`cz-nss`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: decision day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: statedCount parsed from the submitted official search result.
- Integration constraint: A bare search is not an all-corpus query; reuse the date-bounded listing, its session and anti-forgery token. The portal includes administrative decisions from regional courts.

### Publisher-index-first check

GET [https://vyhledavac.nssoud.cz/](https://vyhledavac.nssoud.cz/); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `8792788a75ac118b4b727b6f15e4c8c8f56e9cb5bc566cc36aaaff8ce977d5ef`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
