import { Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { t } from "elysia";

import { applyMarkupCents, prorateHourlyCents } from "@stll/money";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";

const addEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(
    t.Array(tSafeId("timeEntry"), { minItems: 1, maxItems: 500 }),
  ),
  expenseIds: t.Optional(
    t.Array(tSafeId("expense"), { minItems: 1, maxItems: 500 }),
  ),
});

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const buildAttachEvents = (params: {
  invoiceId: SafeId<"invoice">;
  attachedTimeEntries: { id: SafeId<"timeEntry"> }[];
  attachedExpenses: { id: SafeId<"expense"> }[];
  totalAmount: number;
}): AuditEvent[] => {
  const events: AuditEvent[] = [
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: params.invoiceId,
      changes: {
        totalAmount: { old: null, new: params.totalAmount },
        attachedTimeEntries: {
          old: null,
          new: params.attachedTimeEntries.map((row) => row.id),
        },
        attachedExpenses: {
          old: null,
          new: params.attachedExpenses.map((row) => row.id),
        },
      },
    },
  ];
  for (const row of params.attachedTimeEntries) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.APPROVED,
          new: BILLING_STATUS.BILLED,
        },
        invoiceId: { old: null, new: params.invoiceId },
      },
    });
  }
  for (const row of params.attachedExpenses) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.APPROVED,
          new: BILLING_STATUS.BILLED,
        },
        invoiceId: { old: null, new: params.invoiceId },
      },
    });
  }
  return events;
};

const addEntries = createSafeHandler(
  {
    permissions: { invoice: ["update"] },
    params: invoiceParamsSchema,
    body: addEntriesBodySchema,
  },
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
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

    const now = new Date();

    const invoice = yield* Result.await(
      safeDb((tx) =>
        tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
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
          message: "Entries can only be added to draft invoices",
        }),
      );
    }

    const timeEntryIds = body.timeEntryIds;
    if (timeEntryIds && timeEntryIds.length > 0) {
      const entries = yield* Result.await(
        safeDb((tx) =>
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
        ),
      );

      if (entries.length !== timeEntryIds.length) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Some time entries were not found",
          }),
        );
      }

      const invalid = entries.some(
        (entry) =>
          entry.status !== BILLING_STATUS.APPROVED ||
          !entry.billable ||
          entry.invoiceId !== null,
      );
      if (invalid) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "All time entries must be approved, billable," +
              " and not already on an invoice",
          }),
        );
      }
    }

    const expenseIds = body.expenseIds;
    if (expenseIds && expenseIds.length > 0) {
      const expenseRows = yield* Result.await(
        safeDb((tx) =>
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
        ),
      );

      if (expenseRows.length !== expenseIds.length) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "Some expenses were not found",
          }),
        );
      }

      const invalid = expenseRows.some(
        (expense) =>
          expense.status !== BILLING_STATUS.APPROVED ||
          !expense.billable ||
          expense.invoiceId !== null,
      );
      if (invalid) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "All expenses must be approved, billable," +
              " and not already on an invoice",
          }),
        );
      }
    }

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const invoiceCheck = await tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
            workspaceId: { eq: workspaceId },
            status: { eq: INVOICE_STATUS.DRAFT },
          },
          columns: { id: true },
        });
        if (!invoiceCheck) {
          return { ok: false as const };
        }

        let attachedTimeEntries: { id: SafeId<"timeEntry"> }[] = [];
        if (timeEntryIds && timeEntryIds.length > 0) {
          attachedTimeEntries = await tx
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

          if (attachedTimeEntries.length !== timeEntryIds.length) {
            return { ok: false as const };
          }
        }

        let attachedExpenses: { id: SafeId<"expense"> }[] = [];
        if (expenseIds && expenseIds.length > 0) {
          attachedExpenses = await tx
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

          if (attachedExpenses.length !== expenseIds.length) {
            return { ok: false as const };
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
          totalAmount += prorateHourlyCents({
            billedMinutes: entry.billedMinutes,
            hourlyRateCents: entry.rateAtEntry,
          });
        }
        for (const expense of allExpenses) {
          totalAmount += applyMarkupCents({
            amountCents: expense.amount,
            markupPercent: expense.markup,
          });
        }

        await tx
          .update(invoices)
          .set({ totalAmount: cents(totalAmount), updatedAt: now })
          .where(
            and(
              eq(invoices.id, params.invoiceId),
              eq(invoices.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(
          tx,
          buildAttachEvents({
            invoiceId: params.invoiceId,
            attachedTimeEntries,
            attachedExpenses,
            totalAmount,
          }),
        );

        return { ok: true as const, totalAmount };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Some entries were modified concurrently; please retry",
        }),
      );
    }

    return Result.ok({ totalAmount: txResult.totalAmount });
  },
);

export default addEntries;
