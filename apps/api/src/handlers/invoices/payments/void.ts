import { Result } from "better-result";

import { resultTx } from "@/api/db/safe-db";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import {
  invoicePaymentView,
  voidInvoicePayment,
} from "@/api/lib/billing/invoice-payments";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";

const paymentParamsSchema = workspaceParams({
  invoiceId: resourceIdSchema("invoice"),
  paymentId: resourceIdSchema("invoicePayment"),
});

const voidInvoicePaymentHandler = createSafeHandler(
  {
    contract: "patch",
    description:
      "Void a mistaken invoice payment. The payment stays on record as " +
      "voided; a paid invoice it no longer covers returns to sent.",
    permissions: { invoice: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    realtime: invoiceRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: paymentParamsSchema,
  },
  async function* ({
    safeDb,
    user,
    session,
    workspaceId,
    params,
    recordAuditEvent,
  }) {
    const payment = yield* Result.await(
      resultTx(
        safeDb,
        async (tx) =>
          await voidInvoicePayment(
            tx,
            {
              invoiceId: params.invoiceId,
              workspaceId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              now: new Date(),
              recordAuditEvent,
            },
            params.paymentId,
          ),
      ),
    );
    return Result.ok(invoicePaymentView(payment));
  },
);

export default voidInvoicePaymentHandler;
