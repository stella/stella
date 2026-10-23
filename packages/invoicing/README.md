# @stll/invoicing

Pure invoice document calculations and payment QR payloads for Stella: Czech
SPAYD, Slovak PAY by square and the Polish ZBP code.
Amounts use `@stll/money` minor units. VAT is rounded on each line before
document totals and rate breakdowns are summed. Credit notes carry negative
calculated amounts and return a typed non-payable result for payment payloads.

This package produces the payload text; callers render a QR matrix separately.
SPAYD payloads accept Czech variable, constant and specific symbols, each as one
to ten digits.
The invoice PDF picks the code banking apps of the account's country read: PAY
by square for a Slovak (`SK`) IBAN; the ZBP code for a Polish (`PL`) IBAN in PLN
when the seller has a valid NIP, otherwise no code; SPAYD for other accounts.

The package is internal to this repository and is not published.
