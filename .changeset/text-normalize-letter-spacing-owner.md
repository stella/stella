---
"@stll/text-normalize": minor
---

`@stll/text-normalize` reads letter-spaced text in one place: `collapseLetterSpacing`, `documentWordCounts`, `isLetterSpacedEmphasis`, `letterSpacingJoins`, `letterGapCounts` and `joinWordSeams` are added, and `collapseSpacedLetters` is now that reading with spaces squeezed. A short spaced word beside a spaced word reads as a word, a row of one-letter words a sentence writes stays apart, and a no-break space separates words. `spacedLetterRunRegex` is removed from `@stll/text-normalize`; use `letterSpacingJoins` for the gaps a fold removes.
