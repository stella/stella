---
"@stll/text-normalize": minor
---

`collapseLetterSpacing`, `documentWordCounts`, `isLetterSpacedEmphasis` and `letterSpacingJoins` read letter-spaced text in one place, and `collapseSpacedLetters` is now that reading with spaces squeezed: a short spaced word beside a spaced word reads as a word, a row of one-letter words a sentence writes stays apart, and a no-break space separates words. `spacedLetterRunRegex` is removed; use `letterSpacingJoins` for the gaps a fold removes.
