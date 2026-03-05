import { and, eq, inArray, isNull } from "drizzle-orm";
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

export const addEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
  expenseIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
});

type AddEntriesBodySchema = Static<typeof addEntriesBodySchema>;

type AddEntriesHandlerProps = {
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
  body: AddEntriesBodySchema;
};

export const addEntriesHandler = async ({
  workspaceId,
  invoiceId,
  body,
}: AddEntriesHandlerProps) => {
  if (!body.timeEntryIds?.length && !body.expenseIds?.length) {
    return status(400, {
      message: "At least one time entry or expense ID is required",
    });
  }

  const now = new Date();

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
      message: "Entries can only be added to draft invoices",
    });
  }

  // Pre-validate time entries.
  if (body.timeEntryIds?.length) {
    const entries = await db
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
          inArray(timeEntries.id, body.timeEntryIds),
        ),
      );

    if (entries.length !== body.timeEntryIds.length) {
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
  if (body.expenseIds?.length) {
    const expenseRows = await db
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
          inArray(expenses.id, body.expenseIds),
        ),
      );

    if (expenseRows.length !== body.expenseIds.length) {
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
              inArray(timeEntries.id, body.timeEntryIds),
              eq(timeEntries.status, BILLING_STATUS.APPROVED),
              eq(timeEntries.billable, true),
              isNull(timeEntries.invoiceId),
            ),
          );

        const linkedCount = updated.rowCount ?? 0;
        if (linkedCount !== body.timeEntryIds.length) {
          throw new ConcurrentModificationError({
            message: "Entries modified concurrently",
          });
        }
      }

      if (body.expenseIds?.length) {
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
              inArray(expenses.id, body.expenseIds),
              eq(expenses.status, BILLING_STATUS.APPROVED),
              eq(expenses.billable, true),
              isNull(expenses.invoiceId),
            ),
          );

        const linkedCount = updated.rowCount ?? 0;
        if (linkedCount !== body.expenseIds.length) {
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
        totalAmount += Math.round(
          (entry.billedMinutes / 60) * entry.rateAtEntry,
        );
      }
      for (const expense of allExpenses) {
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

      return { totalAmount };
    })
    .catch((err: unknown) => {
      if (err instanceof ConcurrentModificationError) {
        return null;
      }
      throw err;
    });

  if (!result) {
    return status(409, {
      message: "Some entries were modified concurrently; please retry",
    });
  }

  return result;
};
