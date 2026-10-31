---
"@stll/money": minor
---

Add locale decimal input parsing and exact redisplay formatters, with branded `LocaleInputText` values that keep canonical stored decimals out of locale-validated form fields. Parsing accepts locale separators or an unambiguous dot or comma decimal, and reports a typed `LocaleAmountParseError` instead of guessing when text allows two readings.
