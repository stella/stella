---
"@stll/cli": patch
---

`invoices.prefill` returns `issueBlockers`, what would stop the new invoice from being issued. `invoices.transition` refuses to finalize an invoice without a seller profile or a default number series with the codes `invoice_seller_profile_missing` and `invoice_number_series_missing`.
