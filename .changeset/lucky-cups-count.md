---
"@stll/money": minor
"@stll/workspace-ui": patch
---

Money display moves to the package that owns the amounts: `formatMoneyCents` scales by the currency's own exponent, `formatHundredths` renders the fixed-hundredth billing presets, and `currencyMinorUnitDigits` answers the exponent question. The locale is always a parameter. `@stll/workspace-ui/calculation-format` re-exports them, so its consumers are unchanged.
