---
"@stll/text-normalize": minor
---

Add `createSearchQueryMatcher` and `filterBySearchQuery`: the client-side match for user-typed queries. Both sides fold through `foldSearchMatchText`, so case, accents, `ß`/`ł`/`ø`, ligatures and Arabic variants are ignored the same way in every locale.
