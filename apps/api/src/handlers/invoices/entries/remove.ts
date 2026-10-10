import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import { resultTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  INVOICE_ATTACHMENT,
  expenses,
  INVOICE_STATUS,
  invoiceLines,
  timeEntries,
} from "@/api/db/schema";
import {
  requireDraftInvoiceForEntryChanges,
  recalculateInvoiceTotals,
} from "@/api/handlers/invoices/invoice-lines";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const removeEntriesBodySchema = t.Object({
  timeEntryIds: t.Optional(
    t.Array(tSafeId("timeEntry"), { minItems: 1, maxItems: 500 }),
  ),
  expenseIds: t.Optional(
    t.Array(tSafeId("expense"), { minItems: 1, maxItems: 500 }),
  ),
});

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const buildDetachEvents = (params: {
  invoiceId: SafeId<"invoice">;
  detachedTimeEntries: { id: SafeId<"timeEntry"> }[];
  detachedExpenses: { id: SafeId<"expense"> }[];
}): AuditEvent[] => {
  // The new totals record their own invoice event.
  const events: AuditEvent[] = [
    {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
      resourceId: params.invoiceId,
      changes: {
        detachedTimeEntries: {
          old: params.detachedTimeEntries.map((row) => row.id),
          new: null,
        },
        detachedExpenses: {
          old: params.detachedExpenses.map((row) => row.id),
          new: null,
        },
      },
    },
  ];
  for (const row of params.detachedTimeEntries) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  for (const row of params.detachedExpenses) {
    events.push({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
      resourceId: row.id,
      changes: {
        status: {
          old: BILLING_STATUS.BILLED,
          new: BILLING_STATUS.APPROVED,
        },
        invoiceId: { old: params.invoiceId, new: null },
      },
    });
  }
  return events;
};

const removeEntries = createSafeHandler(
  {
    description:
      "Detach time entries and expenses from a draft invoice, removing their " +
      "invoice lines, returning them to approved, unbilled status, and " +
      "recomputing the invoice totals. " +
      "Reversible: the same entries can be attached again with " +
      "invoices.entries.add, and the entries themselves are kept. Only " +
      "draft invoices may " +
      "be changed, and ids that are not on this invoice are skipped without " +
      "an error.",
    permissions: { invoice: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: invoiceParamsSchema,
    body: removeEntriesBodySchema,
  },
  async function* ({
    safeDb,
    user,
    session,
    workspaceId,
    params,
    body,
    recordAuditEvent,
  }) {
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
          message: "Entries can only be removed from draft invoices",
        }),
      );
    }

    const now = new Date();

    const entryChangeScope = {
      invoiceId: params.invoiceId,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      conflictMessage: "Invoice status changed concurrently; please retry",
    };

    const txResult = yield* Result.await(
      resultTx(safeDb, async (tx) => {
        const runningError = await guardRunningTimeEntries({
          tx,
          workspaceId,
          actorUserId: user.id,
          selection: body.timeEntryIds
            ? { type: "entries", ids: body.timeEntryIds }
            : { type: "none" },
        });
        if (runningError) {
          return Result.err(runningError);
        }
        const invoiceResult = await requireDraftInvoiceForEntryChanges(
          tx,
          entryChangeScope,
        );
        if (invoiceResult.isErr()) {
          return Result.err(invoiceResult.error);
        }

        const timeEntryIds = body.timeEntryIds;
        let detachedTimeEntries: { id: SafeId<"timeEntry"> }[] = [];
        if (timeEntryIds && timeEntryIds.length > 0) {
          detachedTimeEntries = await tx
            .update(timeEntries)
            .set({
              invoiceId: null,
              invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
              status: BILLING_STATUS.APPROVED,
              updatedAt: now,
            })
            .where(
              and(
                eq(timeEntries.invoiceId, params.invoiceId),
                eq(timeEntries.workspaceId, workspaceId),
                inArray(timeEntries.id, timeEntryIds),
              ),
            )
            .returning({ id: timeEntries.id });
        }

        const expenseIds = body.expenseIds;
        let detachedExpenses: { id: SafeId<"expense"> }[] = [];
        if (expenseIds && expenseIds.length > 0) {
          detachedExpenses = await tx
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
            )
            .returning({ id: expenses.id });
        }

        const detachedTimeEntryIds = detachedTimeEntries.map((row) => row.id);
        if (detachedTimeEntryIds.length > 0) {
          await tx
            .delete(invoiceLines)
            .where(
              and(
                eq(invoiceLines.invoiceId, params.invoiceId),
                eq(invoiceLines.workspaceId, workspaceId),
                inArray(invoiceLines.timeEntryId, detachedTimeEntryIds),
              ),
            );
        }
        const detachedExpenseIds = detachedExpenses.map((row) => row.id);
        if (detachedExpenseIds.length > 0) {
          await tx
            .delete(invoiceLines)
            .where(
              and(
                eq(invoiceLines.invoiceId, params.invoiceId),
                eq(invoiceLines.workspaceId, workspaceId),
                inArray(invoiceLines.expenseId, detachedExpenseIds),
              ),
            );
        }

        const totals = await recalculateInvoiceTotals(
          tx,
          { invoiceId: params.invoiceId, workspaceId },
          now,
          recordAuditEvent,
        );

        if (totals.isErr()) {
          return Result.err(totals.error);
        }

        await recordAuditEvent(
          tx,
          buildDetachEvents({
            invoiceId: params.invoiceId,
            detachedTimeEntries,
            detachedExpenses,
          }),
        );

        return Result.ok({ success: true });
      }),
    );

    return Result.ok(txResult);
  },
);

export default removeEntries;
