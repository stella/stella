---
"@stll/business-registries": minor
"@stll/country-codes": patch
---

Add browser-safe clients for Switzerland's Zefix API and Croatia's court
register, plus explicit normalized entity and search-result projections for
the Czech, Slovak, British, Polish, French, Swiss, and Croatian adapters.
Publish the canonical country-code types consumed by the registry package.
Canonicalize registry dates, preserve historical date precision, and reject
invalid identifiers before branding them.
