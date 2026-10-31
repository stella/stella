---
"@stll/money": minor
---

Add `parseLocaleMinorUnits` and `formatLocaleMinorUnitsInput`: parses a human-entered amount with locale separators or an unambiguous dot or comma decimal into exact minor units, and returns a typed `LocaleAmountParseError` (`empty`, `syntax`, `ambiguous`, `precision`, `unsafe-integer` or `locale`) instead of guessing when the text allows two readings.
