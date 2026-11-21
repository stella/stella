import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "invoice-document",
  capability:
    "Invoice, advance, and credit note totals and Czech payment payloads",
  owner: ["packages/invoicing/"],
  summary:
    "The package rounds VAT per line, sums document and rate totals in " +
    "branded minor units, and returns SPAYD text for payable documents. " +
    "QR matrix rendering remains with callers.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
