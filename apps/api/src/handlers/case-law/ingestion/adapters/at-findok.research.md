# at-findok publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`at-findok`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `listing-enumerated`.
- Natural reconciliation axis: decision year × UFS/BFG collection; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: Complete weekly official inventory arrays; count only gueltig=true entries, pinning the manifest hash.
- Integration constraint: The inventory enumerates publisher identities. Do not label the computed array length a publisher-stated scalar count. Preserve predecessor/successor year boundaries and snapshot consistency.

### Publisher-index-first check

GET [https://findok.bmf.gv.at/findok/hilfe/EFSZ/BMF/FINDOK-INT-2/BENUTZERUNTERST-TZUNG/Dokumentendownload.html](https://findok.bmf.gv.at/findok/hilfe/EFSZ/BMF/FINDOK-INT-2/BENUTZERUNTERST-TZUNG/Dokumentendownload.html); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `246771580a4a0daace72dd3a455f3b33906b3df7ac88ee4099491f8330056558`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
