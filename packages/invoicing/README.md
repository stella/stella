# @stll/invoicing

Pure invoice document calculations and Czech SPAYD payment payloads for Stella.
Amounts use `@stll/money` minor units. VAT is rounded on each line before
document totals and rate breakdowns are summed. Credit notes carry negative
calculated amounts and return a typed non-payable result for payment payloads.

This package produces the SPAYD text; callers render a QR matrix separately.

The package is internal to this repository and is not published.
