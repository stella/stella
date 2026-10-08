# Invoice, advance, and credit note totals and Czech payment payloads

Generated from `scripts/ownership/invoice-document.ts`. See [Module ownership](../module-ownership.md).

| Capability                                                                               | Owner                 | Enforcement | Summary                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invoice-document` — Invoice, advance, and credit note totals and Czech payment payloads | `packages/invoicing/` | none        | The package rounds VAT per line, sums document and rate totals in branded minor units, and returns SPAYD text for payable documents. QR matrix rendering remains with callers. |
