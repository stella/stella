import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";

import { invoiceSends } from "@/api/db/schema";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  description:
    "Revoke the link an invoice email carried, so it no longer opens the invoice. Revoking twice keeps the first revocation; send the invoice again for a new link.",
  permissions: { invoice: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  realtime: invoiceRealtimeUpdates,
  mcp: {
    type: "capability",
    reason: "billing_admin",
    consumesServices: false,
  },
  params: workspaceParams({
    invoiceId: resourceIdSchema("invoice"),
    sendId: resourceIdSchema("invoiceSend"),
  }),
} satisfies WorkspaceHandlerConfig;

const revokeInvoiceSend = createSafeHandler(
  config,
  async function* ({ safeDb, user, workspaceId, params, recordAuditEvent }) {
    const revoked = yield* Result.await(
      safeDb(async (tx) => {
        const invoice = await tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
            RAW: (table) => invoiceInMatter(table, workspaceId),
          },
          columns: { id: true },
        });
        if (!invoice) {
          return null;
        }
        const now = new Date();
        const [updated] = await tx
          .update(invoiceSends)
          .set({ revokedAt: now, revokedByUserId: user.id })
          .where(
            and(
              eq(invoiceSends.id, params.sendId),
              eq(invoiceSends.invoiceId, invoice.id),
              isNull(invoiceSends.revokedAt),
            ),
          )
          .returning({ revokedAt: invoiceSends.revokedAt });
        if (updated?.revokedAt) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.INVOICE,
            resourceId: invoice.id,
            changes: { linkRevoked: { old: false, new: true } },
            metadata: { invoiceSendId: params.sendId },
          });
          return updated.revokedAt;
        }
        const [existing] = await tx
          .select({ revokedAt: invoiceSends.revokedAt })
          .from(invoiceSends)
          .where(
            and(
              eq(invoiceSends.id, params.sendId),
              eq(invoiceSends.invoiceId, invoice.id),
            ),
          );
        return existing?.revokedAt ?? null;
      }),
    );
    if (revoked === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice send not found" }),
      );
    }
    return Result.ok({ id: params.sendId, revokedAt: revoked.toISOString() });
  },
);

declareAggregateMutation(revokeInvoiceSend, {
  type: "independent",
  reason:
    "Stamps the revocation on one send row of the invoice; the invoice and its lines do not change.",
});

export default revokeInvoiceSend;
