import { and, eq, inArray, isNull } from "drizzle-orm";
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
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";

const addEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
  expenseIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
});

const invoiceParamsSchema = t.Object({
  invoiceId: tNanoid,
});

const addEntries = createHandler(
  {
    permissions: { invoice: ["update"] },
    params: invoiceParamsSchema,
    body: addEntriesBodySchema,
  },
  async ({ scopedDb, workspaceId, params, body }) => {
    if (
      (body.timeEntryIds?.length ?? 0) === 0 &&
      (body.expenseIds?.length ?? 0) === 0
    ) {
      return status(400, {
        message: "At least one time entry or expense ID is required",
      });
    }

    const now = new Date();

    const invoice = await scopedDb((tx) =>
      tx.query.invoices.findFirst({
        where: {
          id: params.invoiceId,
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
        (entry) =>
          entry.status !== BILLING_STATUS.APPROVED ||
          !entry.billable ||
          entry.invoiceId !== null,
      );
      if (invalid) {
        return status(400, {
          message:
            "All time entries must be approved, billable," +
            " and not already on an invoice",
        });
      }
    }

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
        (expense) =>
          expense.status !== BILLING_STATUS.APPROVED ||
          !expense.billable ||
          expense.invoiceId !== null,
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
      const invoiceCheck = await tx.query.invoices.findFirst({
        where: {
          id: params.invoiceId,
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
            invoiceId: params.invoiceId,
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
          )
          .returning({ id: timeEntries.id });

        if (updated.length !== timeEntryIds.length) {
          throw new ConcurrentModificationError({
            message: "Entries modified concurrently",
          });
        }
      }

      if (expenseIds && expenseIds.length > 0) {
        const updated = await tx
          .update(expenses)
          .set({
            invoiceId: params.invoiceId,
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
          )
          .returning({ id: expenses.id });

        if (updated.length !== expenseIds.length) {
          throw new ConcurrentModificationError({
            message: "Entries modified concurrently",
          });
        }
      }

      const allTimeEntries = await tx
        .select({
          billedMinutes: timeEntries.billedMinutes,
          rateAtEntry: timeEntries.rateAtEntry,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.invoiceId, params.invoiceId),
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
            eq(expenses.invoiceId, params.invoiceId),
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
            eq(invoices.id, params.invoiceId),
            eq(invoices.workspaceId, workspaceId),
          ),
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
  },
);

export default addEntries;
