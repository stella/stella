import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { abortableTx } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  expenses,
  invoiceLines,
  timeEntries,
} from "@/api/db/schema";
import {
  lockDraftInvoiceForLines,
  recalculateInvoiceTotals,
} from "@/api/handlers/invoices/invoice-lines";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditEvent } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const lineParamsSchema = workspaceParams({
  invoiceId: tSafeId("invoice"),
  lineId: tSafeId("invoiceLine"),
});

const deleteInvoiceLine = createSafeHandler(
  {
    description:
      "Remove one line from a draft invoice and recompute its totals. A time " +
      "entry or expense line returns its entry to approved, unbilled status, " +
      "so it can be billed again. Only draft invoices can be edited.",
    permissions: { invoice: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: lineParamsSchema,
  },
  async function* ({ safeDb, session, workspaceId, params, recordAuditEvent }) {
    const now = new Date();

    const result = yield* Result.await(
      abortableTx(safeDb, async (tx) => {
        const invoice = await lockDraftInvoiceForLines(tx, {
          invoiceId: params.invoiceId,
          organizationId: session.activeOrganizationId,
          workspaceId,
        });
        if (!invoice) {
          throw new HandlerError({
            status: 409,
            message: "Invoice not found or not in draft status",
          });
        }
        const [line] = await tx
          .delete(invoiceLines)
          .where(
            and(
              eq(invoiceLines.id, params.lineId),
              eq(invoiceLines.invoiceId, params.invoiceId),
              eq(invoiceLines.workspaceId, workspaceId),
            ),
          )
          .returning({
            id: invoiceLines.id,
            source: invoiceLines.source,
            netAmount: invoiceLines.netAmount,
            timeEntryId: invoiceLines.timeEntryId,
            expenseId: invoiceLines.expenseId,
          });
        if (!line) {
          throw new HandlerError({
            status: 404,
            message: "Invoice line not found",
          });
        }

        const events: AuditEvent[] = [];
        if (line.timeEntryId) {
          const released = await tx
            .update(timeEntries)
            .set({
              invoiceId: null,
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

        const totals = await recalculateInvoiceTotals(
          tx,
          { invoiceId: params.invoiceId, workspaceId },
          now,
        );

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
              totalAmount: {
                old: invoice.totalAmount,
                new: totals.grossAmountMinor,
              },
            },
          },
          ...events,
        ]);

        return { id: line.id, totals };
      }),
    );

    return Result.ok(result);
  },
);

export default deleteInvoiceLine;
