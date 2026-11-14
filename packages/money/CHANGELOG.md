# @stll/money

## 0.4.0

### Minor Changes

- [#7629](https://github.com/stella/stella/pull/7629) [`3978f45`](https://github.com/stella/stella/commit/3978f45cea7b4a37d42882f1be9075ea933d2f39) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add locale decimal input parsing and exact redisplay formatters, with branded `LocaleInputText` values that keep canonical stored decimals out of locale-validated form fields: such text comes only from the formatters, from an input element (`localeInputText`) or as `EMPTY_LOCALE_INPUT_TEXT`. Parsing accepts locale separators or an unambiguous dot or comma decimal, and reports a typed `LocaleAmountParseError` instead of guessing when text allows two readings.

- [#7940](https://github.com/stella/stella/pull/7940) [`ad81543`](https://github.com/stella/stella/commit/ad81543e9c85c79cc921caa5b72d7ee39cde94c3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add `toMajorUnitsText`: a stored minor-unit amount as exact major-unit decimal text (`123456 EUR` is `"1234.56"`), for machine readers such as prompts and exports.

## 0.3.1

### Patch Changes

- [#4502](https://github.com/stella/stella/pull/4502) [`ca5df32`](https://github.com/stella/stella/commit/ca5df32b4a006745b026adeb4c572da622be71ce) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add invoice PDF capability metadata and preserve exact minor-unit formatting.

## 0.3.0

### Minor Changes

- [#4582](https://github.com/stella/stella/pull/4582) [`b8a1d41`](https://github.com/stella/stella/commit/b8a1d41da558c4c148fd696a714d56621ecb2db3) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add a shared time-entry amount calculation that honors no-charge time.

## 0.2.3

### Patch Changes

- [#4514](https://github.com/stella/stella/pull/4514) [`ab4d98e`](https://github.com/stella/stella/commit/ab4d98ed5959581bcda956b4163fb9125a4dbd05) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Add matter billing arrangement capabilities and preserve exact minor-unit arithmetic.

## 0.2.2

### Patch Changes

- [#3855](https://github.com/stella/stella/pull/3855) [`87d7e83`](https://github.com/stella/stella/commit/87d7e83e147338c5450be4e3db0904873c862d16) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow values with type guards instead of type assertions, and give internal CLI helpers names that describe what they hold. `mapEntityStatus` now reads only the codes its mapping declares, so an inherited object key maps to `unknown`.

## 0.2.1

### Patch Changes

- [#3728](https://github.com/stella/stella/pull/3728) [`0d6bd5a`](https://github.com/stella/stella/commit/0d6bd5abf19cf86f71a6dd71ad9c39b3435fd8f1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Narrow optional values before they reach rendered text and messages. The outline rail no longer draws a tick for a heading whose id matches an object prototype key.

## 0.2.0

### Minor Changes

- [#2953](https://github.com/stella/stella/pull/2953) [`dd9e048`](https://github.com/stella/stella/commit/dd9e0482f49ef8bda3a19e6a14f26595d5dd7c83) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Money display moves to the package that owns the amounts: `formatMoneyCents`
  renders a stored minor-unit amount and `currencyMinorUnitDigits` answers the
  currency's minor-unit exponent: 2 for USD, where a dollar is 100 cents, and 0
  for JPY. The locale is always a parameter because a package cannot read the
  reader's.

- [#2967](https://github.com/stella/stella/pull/2967) [`5d79253`](https://github.com/stella/stella/commit/5d79253451d8227af942bf0c4883548977531490) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Converting between major and minor units asks the currency.
  `toMinorUnits({ amount, currency })` and `toMajorUnits({ amountCents, currency })` scale by the
  currency's own exponent (100 for USD, 1 for JPY, 1000 for KWD), and
  `formatMoneyCents` takes an optional `fractionDigits` for a rounded summary.

  `toMinorUnits` accepts the decimal TEXT a form holds as well as a number, and
  scales it by moving digits rather than multiplying a float: `1.005` in USD is
  101, where `1.005 * 100` is 100.49999999999999 and rounds to 100. It panics on
  an amount it cannot store; `tryToMinorUnits` returns null instead, for callers
  holding text nobody has vouched for yet.

  BREAKING: `cents()` now rejects an integer outside the safe range, where
  `x + 1 === x` and a running total silently stops moving. `@stll/workspace-ui` no
  longer re-exports `currencyMinorUnitDigits`, `formatMoneyCents`, or
  `FormatMoneyCentsParams`; import them from `@stll/money`.

## 0.1.0

### Minor Changes

- [#2296](https://github.com/stella/stella/pull/2296) [`cee8359`](https://github.com/stella/stella/commit/cee8359ba613f0d16035765d352cc40121a971b1) Thanks [@jan-kubica](https://github.com/jan-kubica)! - Publish the reusable money, calculation, and workspace presentation packages
  with explicit build and export contracts.
