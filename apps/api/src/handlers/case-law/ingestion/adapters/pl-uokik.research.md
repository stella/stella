# pl-uokik publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-uokik`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: decision year plus undated; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: @toplevelentries is the Domino view total; year slice size comes from validated view borders.
- Integration constraint: The full-view total is not each years total. Preserve stable view-border checks; use the exact slice range size already established by reconciliation.

### Publisher-index-first check

GET [https://decyzje.uokik.gov.pl/bp/dec_prez.nsf/decyzje?ReadViewEntries&OutputFormat=JSON&Start=1&Count=1](https://decyzje.uokik.gov.pl/bp/dec_prez.nsf/decyzje?ReadViewEntries&OutputFormat=JSON&Start=1&Count=1); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **live count field verified**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `06f2310e9ae1efa284367581c726eb5895900bbd1f24111aaefa12c4aa66969e`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
