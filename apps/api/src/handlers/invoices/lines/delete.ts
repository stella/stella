import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { InvoiceTotals } from "@stll/invoicing";

import { resultTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  INVOICE_ATTACHMENT,
  expenses,
  invoiceLines,
  timeEntries,
} from "@/api/db/schema";
import {
  lockDraftInvoiceForLines,
  recalculateInvoiceTotals,
} from "@/api/handlers/invoices/invoice-lines";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { flatFeeInvoiceRefusal } from "@/api/lib/billing/invoice-arrangements";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const lineParamsSchema = workspaceParams({
  invoiceId: tSafeId("invoice"),
  lineId: tSafeId("invoiceLine"),
});

type DeletedLine = { id: SafeId<"invoiceLine">; totals: InvoiceTotals };

const deleteInvoiceLine = createSafeHandler(
  {
    description:
      "Remove one line from a draft invoice and recompute its totals. A time " +
      "entry or expense line returns its entry to approved, unbilled status, " +
      "so it can be billed again. Only draft invoices can be edited.",
    permissions: { invoice: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: lineParamsSchema,
  },
  async function* ({
    safeDb,
    user,
    session,
    workspaceId,
    params,
    recordAuditEvent,
  }) {
    const now = new Date();

    const result = yield* Result.await(
      resultTx(
        safeDb,
        async (tx): Promise<Result<DeletedLine, HandlerError>> => {
          const [sourceLine] = await tx
            .select({ timeEntryId: invoiceLines.timeEntryId })
            .from(invoiceLines)
            .where(
              and(
                eq(invoiceLines.id, params.lineId),
                eq(invoiceLines.invoiceId, params.invoiceId),
                eq(invoiceLines.workspaceId, workspaceId),
              ),
            )
            .limit(1);
          const runningError = await guardRunningTimeEntries({
            tx,
            workspaceId,
            actorUserId: user.id,
            selection: {
              type: "entries",
              ids: sourceLine?.timeEntryId ? [sourceLine.timeEntryId] : [],
            },
          });
          if (runningError) {
            return Result.err(runningError);
          }
          const invoiceResult = await lockDraftInvoiceForLines(
            tx,
            {
              invoiceId: params.invoiceId,
              organizationId: session.activeOrganizationId,
              workspaceId,
            },
            recordAuditEvent,
          );
          if (invoiceResult.isErr()) {
            return Result.err(invoiceResult.error);
          }
          const invoice = invoiceResult.value;
          if (!invoice) {
            return Result.err(
              new HandlerError({
                status: 409,
                message: "Invoice not found or not in draft status",
              }),
            );
          }
          if (invoice.billingMode === "flat_fee") {
            return Result.err(flatFeeInvoiceRefusal());
          }
          const lineScope = and(
            eq(invoiceLines.id, params.lineId),
            eq(invoiceLines.invoiceId, params.invoiceId),
            eq(invoiceLines.workspaceId, workspaceId),
          );
          // Found before anything is written, so a refusal commits nothing;
          // the invoice row lock keeps the line in place until the delete.
          const [line] = await tx
            .select({
              id: invoiceLines.id,
              source: invoiceLines.source,
              netAmount: invoiceLines.netAmount,
              timeEntryId: invoiceLines.timeEntryId,
              expenseId: invoiceLines.expenseId,
            })
            .from(invoiceLines)
            .where(lineScope)
            .limit(1);
          if (!line) {
            return Result.err(
              new HandlerError({
                status: 404,
                message: "Invoice line not found",
              }),
            );
          }
          await tx.delete(invoiceLines).where(lineScope);

          const events: AuditEvent[] = [];
          if (line.timeEntryId) {
            const released = await tx
              .update(timeEntries)
              .set({
                invoiceId: null,
                invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
                status: BILLING_STATUS.APPROVED,
                updatedAt: now,
              })
              .where(
                and(
                  eq(timeEntries.id, line.timeEntryId),
                  eq(timeEntries.invoiceId, params.invoiceId),
                  eq(timeEntries.workspaceId, workspaceId),
                ),
              )
              .returning({ id: timeEntries.id });
            events.push(
              ...released.map((row) => ({
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
              })),
            );
          }
          if (line.expenseId) {
            const released = await tx
              .update(expenses)
              .set({
                invoiceId: null,
                status: BILLING_STATUS.APPROVED,
                updatedAt: now,
              })
              .where(
                and(
                  eq(expenses.id, line.expenseId),
                  eq(expenses.invoiceId, params.invoiceId),
                  eq(expenses.workspaceId, workspaceId),
                ),
              )
              .returning({ id: expenses.id });
            events.push(
              ...released.map((row) => ({
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
              })),
            );
          }

          // The new totals record their own invoice event.
          const totals = await recalculateInvoiceTotals(
            tx,
            { invoiceId: params.invoiceId, workspaceId },
            now,
            recordAuditEvent,
          );

          if (totals.isErr()) {
            return Result.err(totals.error);
          }

          await recordAuditEvent(tx, [
            {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
              resourceId: params.invoiceId,
              changes: {
                lineRemoved: {
                  old: {
                    id: line.id,
                    source: line.source,
                    netAmount: line.netAmount,
                  },
                  new: null,
                },
              },
            },
            ...events,
          ]);

          return Result.ok({ id: line.id, totals: totals.value });
        },
      ),
    );

    return Result.ok(result);
  },
);

export default deleteInvoiceLine;
