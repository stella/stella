import { and, eq } from "drizzle-orm";
import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type DeleteInvoiceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
};

export const deleteInvoiceHandler = async ({
  scopedDb,
  workspaceId,
  invoiceId,
}: DeleteInvoiceHandlerProps) => {
  const now = new Date();

  const result = await scopedDb(async (tx) => {
    // Verify draft status before touching linked entries.
    const invoice = await tx.query.invoices.findFirst({
      where: {
        id: invoiceId,
        workspaceId: { eq: workspaceId },
        status: INVOICE_STATUS.DRAFT,
      },
      columns: { id: true },
    });

    if (!invoice) {
      return null;
    }

    // Revert time entries before deleting the invoice,
    // because the FK onDelete: "set null" would nullify
    // invoiceId and prevent the UPDATE from matching.
    await tx
      .update(timeEntries)
      .set({
        status: BILLING_STATUS.APPROVED,
        invoiceId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(timeEntries.invoiceId, invoiceId),
          eq(timeEntries.workspaceId, workspaceId),
        ),
      );

    // Revert expenses before deleting the invoice.
    await tx
      .update(expenses)
      .set({
        status: BILLING_STATUS.APPROVED,
        invoiceId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(expenses.invoiceId, invoiceId),
          eq(expenses.workspaceId, workspaceId),
        ),
      );

    // Delete the invoice.
    await tx
      .delete(invoices)
      .where(
        and(eq(invoices.id, invoiceId), eq(invoices.workspaceId, workspaceId)),
      );

    return { deleted: true };
  });

  if (!result) {
    return status(409, {
      message: "Invoice not found or not in draft status",
    });
  }

  return result;
};
