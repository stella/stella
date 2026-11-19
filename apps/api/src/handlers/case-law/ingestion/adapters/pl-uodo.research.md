# pl-uodo publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-uodo`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `listing-enumerated`.
- Natural reconciliation axis: announcement year plus undated; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: The adapter JSON listing exposes rows, not a total; the public HTML search separately displays a result total.
- Integration constraint: Do not call this source none-exposed: the official HTML search does expose a total. Its default UODO scope need not equal the JSON adapters mixed UODO/Polish-court scope. Reuse JSON enumeration unless an equivalent filtered HTML count is verified.

### Publisher-index-first check

GET [https://orzeczenia.uodo.gov.pl/search](https://orzeczenia.uodo.gov.pl/search); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `923e36b0fcf1f21570379aa1a580f6d7cae9cacab505eadd254a21fb189c22db`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.

Live locator: public `/search` results pager, the `1 - 10 / …` result range.
Its scalar total is visible in server-rendered HTML; equivalence to the JSON
listing filters is not stated.
