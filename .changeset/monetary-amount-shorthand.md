---
"@stll/anonymize": patch
---

Monetary amounts: detect attached lowercase magnitude shorthand (`$25m`, `£500k`, `$25mm`), the English `B` and `MM` abbreviations (`$1.5B`, `$25 MM`), abbreviated magnitudes followed by a period before the currency (`12,5 Mio. Euro`), dash-joined ranges (`USD 10-15 million`), and free-standing written-out English amounts (`twenty-five million dollars`, `a million dollars`). Amount-prefix triggers such as `in the amount of`, `ve výši`, and `in Höhe von` now stop after the amount instead of extending to the next comma or sentence end.

Organizations: with an English-only language scope the legal-form name walk no longer bridges prose between two capitalized words (`Northwind Ventures LLC invested in Acme Holdings Ltd.` is two organizations, not one), and grouped numbers (`45,000,000`) are never absorbed as the head of an organization name.
