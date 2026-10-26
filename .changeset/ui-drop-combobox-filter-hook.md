---
"@stll/ui": minor
---

Remove `useComboboxFilter`. Its `Intl.Collator` match compares equal-length windows (`strasse` never finds `Straße`) and depends on the runtime locale; pass a `filter` built on `createSearchQueryMatcher` from `@stll/text-normalize` instead.
