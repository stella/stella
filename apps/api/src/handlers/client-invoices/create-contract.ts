import * as v from "valibot";

import { createInvoiceBodySchema } from "@/api/lib/billing/invoice-create-contract";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const clientInvoiceBody = v.object({
  ...v.omit(createInvoiceBodySchema, [
    "timeEntryIds",
    "expenseIds",
    "entryAdjustments",
    "documentType",
    "originalInvoiceId",
    "invoiceNumber",
  ]).entries,
  matters: v.pipe(
    v.array(
      v.object({
        workspaceId: resourceIdSchema("workspace"),
        timeEntryIds: v.pipe(
          v.array(resourceIdSchema("timeEntry")),
          v.maxLength(LIMITS.invoiceSourceItemsPerKind),
        ),
        expenseIds: v.pipe(
          v.array(resourceIdSchema("expense")),
          v.maxLength(LIMITS.invoiceSourceItemsPerKind),
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(LIMITS.clientInvoiceMatters),
  ),
});
