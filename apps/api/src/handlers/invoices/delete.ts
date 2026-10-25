import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_ATTACHMENT,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { invoiceContentMutationRefusal } from "@/api/lib/billing/invoice-document-type";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { guardRunningTimeEntries } from "@/api/lib/billing/time-entry-running";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { lockInvoiceInStatus } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const deleteInvoice = createSafeHandler(
  {
    contract: "patch",
    description:
      "Delete a draft invoice and return every time entry and expense on it to " +
      "approved, unbilled status so they can be invoiced again. Only draft " +
      "invoices that have never been issued can be deleted; issued invoices " +
      "require a credit note even after reverting to draft.",
    permissions: { invoice: ["delete"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: invoiceParamsSchema,
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

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const running = await guardRunningTimeEntries({
          tx,
          organizationId: session.activeOrganizationId,
          workspaceId,
          actorUserId: user.id,
          selection: { type: "invoice", invoiceId: params.invoiceId },
        });
        if (running.isErr()) {
          return running.error;
        }
        const invoice = await lockInvoiceInStatus(tx, {
          invoiceId: params.invoiceId,
          workspaceId,
          status: INVOICE_STATUS.DRAFT,
          matterLocks: running.value,
        });

        if (!invoice) {
          return {
            ok: false as const,
            reason: "Invoice not found or not in draft status",
          };
        }

        const refusal = invoiceContentMutationRefusal(invoice);
        if (refusal) {
          return refusal;
        }

        const linkedCredit = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(
            and(
              invoiceInMatter(invoices, workspaceId),
              eq(invoices.originalInvoiceId, invoice.id),
            ),
          )
          .limit(1);
        if (linkedCredit.at(0)) {
          return {
            ok: false as const,
            reason: "Invoice is referenced by a credit note",
          };
        }
        const restoredTimeEntries = await tx
          .update(timeEntries)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            invoiceAttachment: INVOICE_ATTACHMENT.CHARGED,
            updatedAt: now,
          })
          .where(and(eq(timeEntries.invoiceId, params.invoiceId)))
          .returning({ id: timeEntries.id });

        const restoredExpenses = await tx
          .update(expenses)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            updatedAt: now,
          })
          .where(and(eq(expenses.invoiceId, params.invoiceId)))
          .returning({ id: expenses.id });

        await tx
          .delete(invoices)
          .where(
            and(
              eq(invoices.id, params.invoiceId),
              invoiceInMatter(invoices, workspaceId),
              eq(invoices.status, INVOICE_STATUS.DRAFT),
            ),
          );

        await recordBillingCapCrossings(tx, { workspaceId, recordAuditEvent });

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

    if (HandlerError.is(txResult)) {
      return Result.err(txResult);
    }
    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: txResult.reason,
        }),
      );
    }

    return Result.ok({ deleted: txResult.deleted });
  },
);

export default deleteInvoice;
