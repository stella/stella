---
"@stll/money": minor
---

Add `parseLocaleMinorUnits`: parses a human-entered amount in the separators of a formatting locale into exact minor units, and returns a typed `LocaleAmountParseError` (`empty`, `syntax`, `ambiguous` or `unsafe-integer`) instead of guessing when the text allows two readings.
