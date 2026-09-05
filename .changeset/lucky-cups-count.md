---
"@stll/money": minor
---

Money display moves to the package that owns the amounts: `formatMoneyCents`
renders a stored minor-unit amount and `currencyMinorUnitDigits` answers how
many minor units the currency makes of a major one. The locale is always a
parameter, because a package cannot read the reader's.
