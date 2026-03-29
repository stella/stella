import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";

const invoiceParamsSchema = t.Object({
  invoiceId: tNanoid,
});

const deleteInvoice = createHandler(
  {
    permissions: { invoice: ["delete"] },
    params: invoiceParamsSchema,
  },
  async ({ scopedDb, workspaceId, params }) => {
    const now = new Date();

    const result = await scopedDb(async (tx) => {
      const invoice = await tx.query.invoices.findFirst({
        where: {
          id: params.invoiceId,
          workspaceId: { eq: workspaceId },
          status: INVOICE_STATUS.DRAFT,
        },
        columns: { id: true },
      });

      if (!invoice) {
        return null;
      }

      await tx
        .update(timeEntries)
        .set({
          status: BILLING_STATUS.APPROVED,
          invoiceId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(timeEntries.invoiceId, params.invoiceId),
            eq(timeEntries.workspaceId, workspaceId),
          ),
        );

      await tx
        .update(expenses)
        .set({
          status: BILLING_STATUS.APPROVED,
          invoiceId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(expenses.invoiceId, params.invoiceId),
            eq(expenses.workspaceId, workspaceId),
          ),
        );

      await tx
        .delete(invoices)
        .where(
          and(
            eq(invoices.id, params.invoiceId),
            eq(invoices.workspaceId, workspaceId),
          ),
        );

      return { deleted: true };
    });

    if (!result) {
      return status(409, {
        message: "Invoice not found or not in draft status",
      });
    }

    return result;
  },
);

export default deleteInvoice;
