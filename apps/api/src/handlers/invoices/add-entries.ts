import { and, eq, inArray, isNull } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
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

export const addEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
  expenseIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
});

type AddEntriesBodySchema = Static<typeof addEntriesBodySchema>;

type AddEntriesHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
  body: AddEntriesBodySchema;
};

export const addEntriesHandler = async ({
  scopedDb,
  workspaceId,
  invoiceId,
  body,
}: AddEntriesHandlerProps) => {
  if (
    (body.timeEntryIds?.length ?? 0) === 0 &&
    (body.expenseIds?.length ?? 0) === 0
  ) {
    return status(400, {
      message: "At least one time entry or expense ID is required",
    });
  }

  const now = new Date();

  // Pre-validate: invoice must be draft.
  const invoice = await scopedDb((tx) =>
    tx.query.invoices.findFirst({
      where: {
        id: invoiceId,
        workspaceId: { eq: workspaceId },
      },
      columns: { id: true, status: true },
    }),
  );

  if (!invoice) {
    return status(404, { message: "Invoice not found" });
  }

  if (invoice.status !== INVOICE_STATUS.DRAFT) {
    return status(409, {
      message: "Entries can only be added to draft invoices",
    });
  }

  // Pre-validate time entries.
  const timeEntryIds = body.timeEntryIds;
  if (timeEntryIds && timeEntryIds.length > 0) {
    const entries = await scopedDb((tx) =>
      tx
        .select({
          id: timeEntries.id,
          status: timeEntries.status,
          billable: timeEntries.billable,
          invoiceId: timeEntries.invoiceId,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, workspaceId),
            inArray(timeEntries.id, timeEntryIds),
          ),
        ),
    );

    if (entries.length !== timeEntryIds.length) {
      return status(400, {
        message: "Some time entries were not found",
      });
    }

    const invalid = entries.some(
      (e) =>
        e.status !== BILLING_STATUS.APPROVED ||
        !e.billable ||
        e.invoiceId !== null,
    );
    if (invalid) {
      return status(400, {
        message:
          "All time entries must be approved, billable," +
          " and not already on an invoice",
      });
    }
  }

  // Pre-validate expenses.
  const expenseIds = body.expenseIds;
  if (expenseIds && expenseIds.length > 0) {
    const expenseRows = await scopedDb((tx) =>
      tx
        .select({
          id: expenses.id,
          status: expenses.status,
          billable: expenses.billable,
          invoiceId: expenses.invoiceId,
        })
        .from(expenses)
        .where(
          and(
            eq(expenses.workspaceId, workspaceId),
            inArray(expenses.id, expenseIds),
          ),
        ),
    );

    if (expenseRows.length !== expenseIds.length) {
      return status(400, {
        message: "Some expenses were not found",
      });
    }

    const invalid = expenseRows.some(
      (e) =>
        e.status !== BILLING_STATUS.APPROVED ||
        !e.billable ||
        e.invoiceId !== null,
    );
    if (invalid) {
      return status(400, {
        message:
          "All expenses must be approved, billable," +
          " and not already on an invoice",
      });
    }
  }

  const result = await scopedDb(async (tx) => {
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

    if (timeEntryIds && timeEntryIds.length > 0) {
      const updated = await tx
        .update(timeEntries)
        .set({
          invoiceId,
          status: BILLING_STATUS.BILLED,
          updatedAt: now,
        })
        .where(
          and(
            eq(timeEntries.workspaceId, workspaceId),
            inArray(timeEntries.id, timeEntryIds),
            eq(timeEntries.status, BILLING_STATUS.APPROVED),
            eq(timeEntries.billable, true),
            isNull(timeEntries.invoiceId),
          ),
        );

      const linkedCount = updated.rowCount ?? 0;
      if (linkedCount !== timeEntryIds.length) {
        throw new ConcurrentModificationError({
          message: "Entries modified concurrently",
        });
      }
    }

    if (expenseIds && expenseIds.length > 0) {
      const updated = await tx
        .update(expenses)
        .set({
          invoiceId,
          status: BILLING_STATUS.BILLED,
          updatedAt: now,
        })
        .where(
          and(
            eq(expenses.workspaceId, workspaceId),
            inArray(expenses.id, expenseIds),
            eq(expenses.status, BILLING_STATUS.APPROVED),
            eq(expenses.billable, true),
            isNull(expenses.invoiceId),
          ),
        );

      const linkedCount = updated.rowCount ?? 0;
      if (linkedCount !== expenseIds.length) {
        throw new ConcurrentModificationError({
          message: "Entries modified concurrently",
        });
      }
    }

    // Recalculate total from all linked entries.
    const allTimeEntries = await tx
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

    const allExpenses = await tx
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
    for (const entry of allTimeEntries) {
      totalAmount += Math.round((entry.billedMinutes / 60) * entry.rateAtEntry);
    }
    for (const expense of allExpenses) {
      const markupMultiplier = 1 + expense.markup / 100;
      totalAmount += Math.round(expense.amount * markupMultiplier);
    }

    await tx
      .update(invoices)
      .set({ totalAmount, updatedAt: now })
      .where(
        and(eq(invoices.id, invoiceId), eq(invoices.workspaceId, workspaceId)),
      );

    return { totalAmount };
  }).catch((error: unknown) => {
    if (error instanceof ConcurrentModificationError) {
      return null;
    }
    throw error;
  });

  if (!result) {
    return status(409, {
      message: "Some entries were modified concurrently; please retry",
    });
  }

  return result;
};
