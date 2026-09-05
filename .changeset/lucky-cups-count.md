---
"@stll/money": minor
---

Money display moves to the package that owns the amounts: `formatMoneyCents`
renders a stored minor-unit amount and `currencyMinorUnitDigits` answers the
currency's minor-unit exponent: 2 for USD, where a dollar is 100 cents, and 0
for JPY. The locale is always a parameter because a package cannot read the
reader's.
