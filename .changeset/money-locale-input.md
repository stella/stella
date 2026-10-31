---
"@stll/money": minor
---

Add `parseLocaleMinorUnits` and `formatLocaleMinorUnitsInput`: parses a human-entered amount in the separators of a formatting locale into exact minor units, and returns a typed `LocaleAmountParseError` (`empty`, `syntax`, `ambiguous`, `precision`, `unsafe-integer` or `locale`) instead of guessing when the text allows two readings.
