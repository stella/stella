import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { invoices } from "@/api/db/schema";
import type { InvoiceStatus } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type LockInvoiceOptions = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
  status: InvoiceStatus | readonly InvoiceStatus[];
};

/**
 * Locks the invoice row with `SELECT ... FOR UPDATE` and returns the columns
 * every mutation handler (update, transition, delete) needs to make its
 * status-conditional decision. Callers must re-check `status` (or the
 * relevant precondition) inside the same transaction before mutating, and
 * repeat the identical status filter on the mutating statement itself: the
 * lock alone does not stop a concurrent transaction from having already
 * committed a status change before this one started.
 */
export const lockInvoiceInStatus = async (
  tx: Transaction,
  { invoiceId, workspaceId, status }: LockInvoiceOptions,
) => {
  const statusFilter = Array.isArray(status)
    ? inArray(invoices.status, [...status])
    : eq(invoices.status, status);

  const rows = await tx
    .select({
      id: invoices.id,
      status: invoices.status,
      currency: invoices.currency,
      dueDate: invoices.dueDate,
      invoiceDate: invoices.invoiceDate,
      invoiceNumber: invoices.invoiceNumber,
      notes: invoices.notes,
      reference: invoices.reference,
      totalAmount: invoices.totalAmount,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.workspaceId, workspaceId),
        statusFilter,
      ),
    )
    .limit(1)
    .for("update");

  return rows.at(0);
};
