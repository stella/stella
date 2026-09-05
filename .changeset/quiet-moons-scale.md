---
"@stll/money": minor
"@stll/workspace-ui": minor
---

Converting between major and minor units asks the currency. `toMinorUnits({
amount, currency })` and `toMajorUnits({ amountCents, currency })` scale by the
currency's own exponent (100 for USD, 1 for JPY, 1000 for KWD), and
`formatMoneyCents` takes an optional `fractionDigits` for a rounded summary.

`toMinorUnits` accepts the decimal TEXT a form holds as well as a number, and
scales it by moving digits rather than multiplying a float: `1.005` in USD is
101, where `1.005 * 100` is 100.49999999999999 and rounds to 100. It panics on
an amount it cannot store; `tryToMinorUnits` returns null instead, for callers
holding text nobody has vouched for yet.

BREAKING: `cents()` now rejects an integer outside the safe range, where `x + 1
=== x` and a running total silently stops moving. `@stll/workspace-ui` no
longer re-exports `currencyMinorUnitDigits`, `formatMoneyCents`, or
`FormatMoneyCentsParams`; import them from `@stll/money`.
