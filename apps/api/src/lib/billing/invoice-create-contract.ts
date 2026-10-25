import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import { currencyCodeSchema } from "@stll/api-contract/currency-code";

import { tInvoiceDocumentType } from "@/api/lib/billing/invoice-document-type";
import {
  invoiceLanguageSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createInvoiceBodySchema = v.object({
  invoiceNumber: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  ),
  documentType: v.optional(tInvoiceDocumentType),
  originalInvoiceId: v.optional(resourceIdSchema("invoice")),
  invoiceDate: apiDateSchema,
  dueDate: v.optional(v.nullable(apiDateSchema)),
  reference: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(256)))),
  currency: currencyCodeSchema,
  language: v.optional(invoiceLanguageSchema),
  notes: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(10_000)))),
  timeEntryIds: v.pipe(
    v.array(resourceIdSchema("timeEntry")),
    v.minLength(0),
    v.maxLength(LIMITS.invoiceSourceItemsPerKind),
  ),
  expenseIds: v.optional(
    v.pipe(
      v.array(resourceIdSchema("expense")),
      v.minLength(0),
      v.maxLength(LIMITS.invoiceSourceItemsPerKind),
      v.description(
        "Approved, billable, not-yet-invoiced expenses of the matter to bill on this invoice",
      ),
    ),
  ),
  entryAdjustments: v.optional(
    v.pipe(
      v.array(
        v.object({
          timeEntryId: resourceIdSchema("timeEntry"),
          billedMinutes: v.pipe(
            v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100_000)),
            v.description(
              "Minutes to bill for the entry; its logged duration stays",
            ),
          ),
          noCharge: v.pipe(
            v.boolean(),
            v.description("Show the entry on the invoice at no charge"),
          ),
        }),
      ),
      v.maxLength(LIMITS.invoiceSourceItemsPerKind),
      v.description(
        "Billed minutes and no-charge to set on entries in timeEntryIds before they are billed; needs approval rights",
      ),
    ),
  ),
  sellerProfileId: v.optional(resourceIdSchema("sellerProfile")),
  taxableSupplyDate: v.optional(v.nullable(apiDateSchema)),
  expectedTotalAmount: v.optional(
    v.pipe(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(-Number.MAX_SAFE_INTEGER),
        v.maxValue(Number.MAX_SAFE_INTEGER),
      ),
      v.description(
        "Gross total in minor units that the caller reviewed; the invoice is not created when the computed total differs",
      ),
    ),
  ),
});
