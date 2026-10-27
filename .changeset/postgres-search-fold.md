---
"@stll/text-normalize": minor
---

Add `foldLikePostgresSearch`, `foldLikePostgresSearchWithOffsets` and `findPostgresSearchFoldRanges` at `@stll/text-normalize/postgres-search-fold`: PostgreSQL's `lower(unaccent(...))` reproduced code point for code point, with offsets back into the original text, for highlighting exactly what a server-side `unaccent` match found. `POSTGRES_UNACCENT_RULES` (`@stll/text-normalize/unaccent-rules`) is the extension's full default rule set.
