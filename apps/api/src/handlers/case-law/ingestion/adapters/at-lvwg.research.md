# at-lvwg publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`at-lvwg`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: decision month; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: RIS OGD Hits.#text for Applikation=Lvwg, decision texts only.
- Integration constraint: Preserve the application and month boundaries. Headnotes and decision texts are different artifacts.

### Publisher-index-first check

GET [https://www.ris.bka.gv.at/UI/Ogd.aspx](https://www.ris.bka.gv.at/UI/Ogd.aspx); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `fc1850e4445fd193ea60582c53b36f286deec89f695f568b0f0876cabeec5787`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
