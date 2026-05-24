import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const deleteInvoice = createSafeHandler(
  {
    permissions: { invoice: ["delete"] },
    params: invoiceParamsSchema,
  },
  async function* ({ safeDb, workspaceId, params, recordAuditEvent }) {
    const now = new Date();

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const invoice = await tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
            workspaceId: { eq: workspaceId },
            status: { eq: INVOICE_STATUS.DRAFT },
          },
          columns: { id: true, invoiceNumber: true, totalAmount: true },
        });

        if (!invoice) {
          return { ok: false as const };
        }

        const restoredTimeEntries = await tx
          .update(timeEntries)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.invoiceId, params.invoiceId),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          )
          .returning({ id: timeEntries.id });

        const restoredExpenses = await tx
          .update(expenses)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(expenses.invoiceId, params.invoiceId),
              eq(expenses.workspaceId, workspaceId),
            ),
          )
          .returning({ id: expenses.id });

        await tx
          .delete(invoices)
          .where(
            and(
              eq(invoices.id, params.invoiceId),
              eq(invoices.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: invoice.id,
            changes: {
              deleted: {
                old: {
                  invoiceNumber: invoice.invoiceNumber,
                  totalAmount: invoice.totalAmount,
                },
                new: null,
              },
            },
          },
          ...restoredTimeEntries.map((row) => ({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
            resourceId: row.id,
            changes: {
              status: {
                old: BILLING_STATUS.BILLED,
                new: BILLING_STATUS.APPROVED,
              },
              invoiceId: { old: invoice.id, new: null },
            },
          })),
          ...restoredExpenses.map((row) => ({
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.EXPENSE,
            resourceId: row.id,
            changes: {
              status: {
                old: BILLING_STATUS.BILLED,
                new: BILLING_STATUS.APPROVED,
              },
              invoiceId: { old: invoice.id, new: null },
            },
          })),
        ]);

        return { ok: true as const, deleted: true };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Invoice not found or not in draft status",
        }),
      );
    }

    return Result.ok({ deleted: txResult.deleted });
  },
);

export default deleteInvoice;
