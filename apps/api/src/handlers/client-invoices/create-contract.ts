import { t } from "elysia";

import { createInvoiceBodySchema } from "@/api/lib/billing/invoice-create-contract";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const clientInvoiceBody = t.Composite([
  t.Omit(createInvoiceBodySchema, [
    "timeEntryIds",
    "expenseIds",
    "entryAdjustments",
    "documentType",
    "originalInvoiceId",
    "invoiceNumber",
  ]),
  t.Object({
    matters: t.Array(
      t.Object({
        workspaceId: tSafeId("workspace"),
        timeEntryIds: t.Array(tSafeId("timeEntry"), {
          maxItems: LIMITS.invoiceSourceItemsPerKind,
        }),
        expenseIds: t.Array(tSafeId("expense"), {
          maxItems: LIMITS.invoiceSourceItemsPerKind,
        }),
      }),
      { minItems: 1, maxItems: LIMITS.clientInvoiceMatters },
    ),
  }),
]);
