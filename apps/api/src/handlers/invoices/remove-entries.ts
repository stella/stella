import { and, eq, inArray } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { tNanoid } from "@/api/lib/custom-schema";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";

export const removeEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
  expenseIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
});

type RemoveEntriesBodySchema = Static<typeof removeEntriesBodySchema>;

type RemoveEntriesHandlerProps = {
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
  body: RemoveEntriesBodySchema;
};

export const removeEntriesHandler = async ({
  workspaceId,
  invoiceId,
  body,
}: RemoveEntriesHandlerProps) => {
  if (!body.timeEntryIds?.length && !body.expenseIds?.length) {
    return status(400, {
      message: "At least one time entry or expense ID is required",
    });
  }

  // Pre-validate: invoice must be draft.
  const invoice = await db.query.invoices.findFirst({
    where: {
      id: invoiceId,
      workspaceId: { eq: workspaceId },
    },
    columns: { id: true, status: true },
  });

  if (!invoice) {
    return status(404, { message: "Invoice not found" });
  }

  if (invoice.status !== INVOICE_STATUS.DRAFT) {
    return status(409, {
      message: "Entries can only be removed from draft invoices",
    });
  }

  const now = new Date();

  const result = await db
    .transaction(async (tx) => {
      // Re-verify draft status inside tx to prevent TOCTOU race.
      const invoiceCheck = await tx.query.invoices.findFirst({
        where: {
          id: invoiceId,
          workspaceId: { eq: workspaceId },
          status: INVOICE_STATUS.DRAFT,
        },
        columns: { id: true },
      });
      if (!invoiceCheck) {
        throw new ConcurrentModificationError({
          message: "Invoice status changed concurrently",
        });
      }

      if (body.timeEntryIds?.length) {
        await tx
          .update(timeEntries)
          .set({
            invoiceId: null,
            status: BILLING_STATUS.APPROVED,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.invoiceId, invoiceId),
              eq(timeEntries.workspaceId, workspaceId),
              inArray(timeEntries.id, body.timeEntryIds),
            ),
          );
      }

      if (body.expenseIds?.length) {
        await tx
          .update(expenses)
          .set({
            invoiceId: null,
            status: BILLING_STATUS.APPROVED,
            updatedAt: now,
          })
          .where(
            and(
              eq(expenses.invoiceId, invoiceId),
              eq(expenses.workspaceId, workspaceId),
              inArray(expenses.id, body.expenseIds),
            ),
          );
      }

      // Recalculate total from remaining entries.
      const remainingTimeEntries = await tx
        .select({
          billedMinutes: timeEntries.billedMinutes,
          rateAtEntry: timeEntries.rateAtEntry,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.invoiceId, invoiceId),
            eq(timeEntries.workspaceId, workspaceId),
          ),
        );

      const remainingExpenses = await tx
        .select({
          amount: expenses.amount,
          markup: expenses.markup,
        })
        .from(expenses)
        .where(
          and(
            eq(expenses.invoiceId, invoiceId),
            eq(expenses.workspaceId, workspaceId),
          ),
        );

      let totalAmount = 0;
      for (const entry of remainingTimeEntries) {
        totalAmount += Math.round(
          (entry.billedMinutes / 60) * entry.rateAtEntry,
        );
      }
      for (const expense of remainingExpenses) {
        const markupMultiplier = 1 + expense.markup / 100;
        totalAmount += Math.round(expense.amount * markupMultiplier);
      }

      await tx
        .update(invoices)
        .set({ totalAmount, updatedAt: now })
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.workspaceId, workspaceId),
          ),
        );

      return { success: true };
    })
    .catch((err: unknown) => {
      if (err instanceof ConcurrentModificationError) {
        return null;
      }
      throw err;
    });

  if (!result) {
    return status(409, {
      message: "Invoice status changed concurrently; please retry",
    });
  }

  return result;
};
