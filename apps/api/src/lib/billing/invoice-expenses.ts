import { and, eq, inArray, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { BILLING_STATUS, expenses } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type ClaimInvoiceExpensesOptions = {
  workspaceId: SafeId<"workspace">;
  invoiceId: SafeId<"invoice">;
  expenseIds: readonly SafeId<"expense">[];
  currency: string;
  now: Date;
};

/**
 * Marks approved, billable, not-yet-invoiced expenses in the invoice
 * currency billed on a draft invoice, and returns the ones it claimed; fewer
 * rows than requested means a concurrent change. Callers record the attach
 * events and write the lines in the same transaction.
 */
export const claimInvoiceExpenses = async (
  tx: Transaction,
  {
    workspaceId,
    invoiceId,
    expenseIds,
    currency,
    now,
  }: ClaimInvoiceExpensesOptions,
) =>
  // audit: skip - callers record each claimed expense in the same transaction
  await tx
    .update(expenses)
    .set({ invoiceId, status: BILLING_STATUS.BILLED, updatedAt: now })
    .where(
      and(
        eq(expenses.workspaceId, workspaceId),
        inArray(expenses.id, [...expenseIds]),
        eq(expenses.status, BILLING_STATUS.APPROVED),
        eq(expenses.billable, true),
        isNull(expenses.invoiceId),
        eq(expenses.currency, currency),
      ),
    )
    .returning({
      id: expenses.id,
      dateIncurred: expenses.dateIncurred,
      amount: expenses.amount,
      markup: expenses.markup,
      description: expenses.description,
      invoiceDescription: expenses.invoiceDescription,
    });
