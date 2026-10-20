# pl-nsa publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`pl-nsa`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `none-exposed`.
- Natural reconciliation axis: pinned dataset shard (with decision year on records); retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: Parquet footer rows describe a pinned JuDDGES mirror, not a contemporaneous official NSA corpus count.
- Integration constraint: The official CBOSA index could not be verified in this pass. A completed mirror-shard enumeration proves only mirror completeness. Never promote it to current official-publisher completeness.

### Publisher-index-first check

GET [https://orzeczenia.nsa.gov.pl/](https://orzeczenia.nsa.gov.pl/); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: unverified: Remote end closed connection without response.
Evidence status: **unverified: Remote end closed connection without response**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.

Secondary cross-check: [JuDDGES dataset card](https://huggingface.co/datasets/JuDDGES/pl-nsa),
section “Source Data”, describes scraping the NSA website and deduplication.
The mirror is a lead and a bounded import source; it is not official evidence
of all decisions currently held by CBOSA. The official-index check above
failed, so official completeness remains unmeasured.
