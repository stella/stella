---
"@stll/text-normalize": minor
---

`findSearchMatchRanges`, `foldSearchMatchText` and `foldSearchMatchTextWithOffsets` take opt-in `matchCase`, `matchDiacritics` and `wholeWords` options, and `hasFoldedSearchMatch` checks a cached folded string under the same options. Calls without options fold and match as before.
