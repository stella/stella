---
"@stll/business-registries": minor
"@stll/cli": minor
---

Add the `cz-vat-reliability` entity check: the Czech VAT register's unreliable-payer status and published bank accounts for a DIČ. An IČO is sent as `CZ` + IČO and the result marks the DIČ as derived. A DIČ the register does not hold is reported as `not-registered`, never as clear.
