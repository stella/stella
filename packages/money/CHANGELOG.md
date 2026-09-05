# @stll/money

## 0.2.0

### Minor Changes

- [#2953](https://github.com/stella/stella/pull/2953) [`dd9e048`](https://github.com/stella/stella/commit/dd9e0482f49ef8bda3a19e6a14f26595d5dd7c83) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Money display moves to the package that owns the amounts: `formatMoneyCents`
  renders a stored minor-unit amount and `currencyMinorUnitDigits` answers the
  currency's minor-unit exponent: 2 for USD, where a dollar is 100 cents, and 0
  for JPY. The locale is always a parameter because a package cannot read the
  reader's.

- [#2967](https://github.com/stella/stella/pull/2967) [`5d79253`](https://github.com/stella/stella/commit/5d79253451d8227af942bf0c4883548977531490) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Converting between major and minor units asks the currency. `toMinorUnits({
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

## 0.1.0

### Minor Changes

- [#2296](https://github.com/stella/stella/pull/2296) [`cee8359`](https://github.com/stella/stella/commit/cee8359ba613f0d16035765d352cc40121a971b1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the reusable money, calculation, and workspace presentation packages
  with explicit build and export contracts.
