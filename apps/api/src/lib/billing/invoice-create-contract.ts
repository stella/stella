import { t } from "elysia";

import { tInvoiceDocumentType } from "@/api/lib/billing/invoice-document-type";
import {
  tCurrencyCode,
  tInvoiceLanguage,
  tSafeId,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  documentType: t.Optional(tInvoiceDocumentType),
  originalInvoiceId: t.Optional(tSafeId("invoice")),
  invoiceDate: t.String({ format: "date" }),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: tCurrencyCode,
  language: t.Optional(tInvoiceLanguage),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
  timeEntryIds: t.Array(tSafeId("timeEntry"), {
    minItems: 0,
    maxItems: LIMITS.invoiceSourceItemsPerKind,
  }),
  expenseIds: t.Optional(
    t.Array(tSafeId("expense"), {
      minItems: 0,
      maxItems: LIMITS.invoiceSourceItemsPerKind,
      description:
        "Approved, billable, not-yet-invoiced expenses of the matter to bill on this invoice",
    }),
  ),
  entryAdjustments: t.Optional(
    t.Array(
      t.Object({
        timeEntryId: tSafeId("timeEntry"),
        billedMinutes: t.Integer({
          minimum: 0,
          maximum: 100_000,
          description:
            "Minutes to bill for the entry; its logged duration stays",
        }),
        noCharge: t.Boolean({
          description: "Show the entry on the invoice at no charge",
        }),
      }),
      {
        maxItems: LIMITS.invoiceSourceItemsPerKind,
        description:
          "Billed minutes and no-charge to set on entries in timeEntryIds before they are billed; needs approval rights",
      },
    ),
  ),
  sellerProfileId: t.Optional(tSafeId("sellerProfile")),
  taxableSupplyDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  expectedTotalAmount: t.Optional(
    t.Integer({
      minimum: -Number.MAX_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
      description:
        "Gross total in minor units that the caller reviewed; the invoice is not created when the computed total differs",
    }),
  ),
});
