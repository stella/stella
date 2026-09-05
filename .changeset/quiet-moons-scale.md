---
"@stll/money": minor
"@stll/workspace-ui": minor
---

Converting between major and minor units asks the currency. `toMinorUnits({
amount, currency })` and `toMajorUnits({ amountCents, currency })` scale by the
currency's own exponent (100 for USD, 1 for JPY, 1000 for KWD), and
`formatMoneyCents` takes an optional `fractionDigits` for a rounded summary.

`@stll/workspace-ui` no longer re-exports `currencyMinorUnitDigits`,
`formatMoneyCents`, or `FormatMoneyCentsParams`; import them from `@stll/money`.
