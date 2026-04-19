import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const removeEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
  expenseIds: t.Optional(t.Array(tNanoid, { minItems: 1, maxItems: 500 })),
});

const invoiceParamsSchema = t.Object({
  invoiceId: tNanoid,
});

const removeEntries = createSafeHandler(
  {
    permissions: { invoice: ["update"] },
    params: invoiceParamsSchema,
    body: removeEntriesBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body }) {
    if (
      (body.timeEntryIds?.length ?? 0) === 0 &&
      (body.expenseIds?.length ?? 0) === 0
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "At least one time entry or expense ID is required",
        }),
      );
    }

    const invoice = yield* Result.await(
      safeDb((tx) =>
        tx.query.invoices.findFirst({
          where: {
            id: params.invoiceId,
            workspaceId: { eq: workspaceId },
          },
          columns: { id: true, status: true },
        }),
      ),
    );

    if (!invoice) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice not found" }),
      );
    }

    if (invoice.status !== INVOICE_STATUS.DRAFT) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Entries can only be removed from draft invoices",
        }),
      );
    }

    const now = new Date();

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const invoiceCheck = await tx.query.invoices.findFirst({
          where: {
            id: params.invoiceId,
            workspaceId: { eq: workspaceId },
            status: INVOICE_STATUS.DRAFT,
          },
          columns: { id: true },
        });
        if (!invoiceCheck) {
          return { ok: false as const };
        }

        const timeEntryIds = body.timeEntryIds;
        if (timeEntryIds && timeEntryIds.length > 0) {
          await tx
            .update(timeEntries)
            .set({
              invoiceId: null,
              status: BILLING_STATUS.APPROVED,
              updatedAt: now,
            })
            .where(
              and(
                eq(timeEntries.invoiceId, params.invoiceId),
                eq(timeEntries.workspaceId, workspaceId),
                inArray(timeEntries.id, timeEntryIds),
              ),
            );
        }

        const expenseIds = body.expenseIds;
        if (expenseIds && expenseIds.length > 0) {
          await tx
            .update(expenses)
            .set({
              invoiceId: null,
              status: BILLING_STATUS.APPROVED,
              updatedAt: now,
            })
            .where(
              and(
                eq(expenses.invoiceId, params.invoiceId),
                eq(expenses.workspaceId, workspaceId),
                inArray(expenses.id, expenseIds),
              ),
            );
        }

        const remainingTimeEntries = await tx
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

        const remainingExpenses = await tx
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
              eq(invoices.id, params.invoiceId),
              eq(invoices.workspaceId, workspaceId),
            ),
          );

        return { ok: true as const };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Invoice status changed concurrently; please retry",
        }),
      );
    }

    return Result.ok({ success: true });
  },
);

export default removeEntries;
