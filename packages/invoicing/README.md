# @stll/invoicing

Pure invoice document calculations and payment QR payloads for Stella: Czech
SPAYD and Slovak PAY by square.
Amounts use `@stll/money` minor units. VAT is rounded on each line before
document totals and rate breakdowns are summed. Credit notes carry negative
calculated amounts and return a typed non-payable result for payment payloads.

This package produces the payload text; callers render a QR matrix separately.
The invoice PDF uses PAY by square for a Slovak (`SK`) IBAN, since Slovak
banking apps do not read SPAYD, and SPAYD otherwise.

The package is internal to this repository and is not published.
