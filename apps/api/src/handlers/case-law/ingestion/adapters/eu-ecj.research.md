# eu-ecj publisher census

## Completeness census

Research date: 2026-10-16; pass A.

Registration authority: `adapter-registry.ts` / `ADAPTER_KEYS`; see
[the census scope and method](census.research.md). The registered source key is
`eu-ecj`. This describes the registered publication corpus, not every case
handled by its courts.

- Recommended observation: `listing-enumerated`.
- Natural reconciliation axis: year, enumerated through month windows × language; retain decision year separately when the
  publisher axis uses publication time or dataset position.
- Count surface: The Cellar SPARQL listing enumerates distinct CELEX/language XHTML variants; a separate COUNT query exists in the adapter.
- Integration constraint: A work is not a stored language manifestation. Keep the same language and XHTML scope on both sides. Twelve structural month pages do not state twelve publisher result pages.

### Publisher-index-first check

GET [https://publications.europa.eu/webapi/rdf/sparql](https://publications.europa.eu/webapi/rdf/sparql); query: publisher index or minimal listing,
no text term; retrieval date 2026-10-16; result: HTTP 200.
Evidence status: **official index retrieved; exact census query not executed**. The count-field identification above is based on
existing adapter readers and fixtures except where explicitly live verified.
No extra bulk query or corpus sweep was performed for this research.

Archived response SHA-256: `7c4bb03b75507d68a92993c2923a929ef4bbe147a80d7e7fbf1e37b9d57c2ffe`.

The private research archive retains the response and request log. A blocked
request is `unverified`, never `none-found`; no count absence is inferred from
a landing page. Pass-B reconciliation is tracked in the census scope note.
