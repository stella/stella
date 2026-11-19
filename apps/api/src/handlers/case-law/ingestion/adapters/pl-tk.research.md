# pl-tk publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-tk`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `listing-enumerated`.
- Natural reconciliation axis: decision year × proceeding stage; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: The print listing states page totals; exact rows are enumerated across merits, signalling, and preliminary stages.
- Integration constraint: Pages are not a publisher-stated row count. The final page determines rows. Preserve stage cookies and year bisection; all three stages belong in the denominator.

### Publisher-index-first check

GET [https://ipo.trybunal.gov.pl/ipo/](https://ipo.trybunal.gov.pl/ipo/); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: unverified: The read operation timed out.
Evidence status: **unverified: The read operation timed out**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
