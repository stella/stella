# pl-kio publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-kio`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `publisher-count`.
- Natural reconciliation axis: issue day; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: hidden input resultCounts, ordered ALL,KIO,SO,SA,SN; the adapter uses ALL.
- Integration constraint: Reuse the existing GetResults response with CountStats=True. Scope includes court review decisions published with KIO decisions; do not benchmark only the KIO component.

Scope audit: the normal reconciliation walk covers dated issue-day slices and
does not enumerate the undated tail that the crawl separately handles. Until
that tail has its own census slice, this is `partial-publisher` coverage and
must not yield a complete source or country verdict.

### Publisher-index-first check

GET [https://orzeczenia.uzp.gov.pl/](https://orzeczenia.uzp.gov.pl/); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `9d159edd163826cce7e52fb3d1de6eb4a51f7511d5d98c33e546dc3da74507dc`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
