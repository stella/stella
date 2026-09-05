---
"@stll/money": minor
"@stll/workspace-ui": minor
---

Money conversion and display move to the package that owns the amounts.
`toMinorUnits` and `toMajorUnits` scale a typed amount by the currency's own
exponent, `formatMoneyCents` renders on the same rule and takes an optional
`fractionDigits` for a rounded summary, and `currencyMinorUnitDigits` answers
the exponent question. The locale is always a parameter. `@stll/workspace-ui`
no longer re-exports the money helpers; import them from `@stll/money`.
