import { Result } from "better-result";
import * as v from "valibot";

import {
  INVOICE_PAYMENT_INPUT_LIMITS,
  INVOICE_PAYMENT_METHODS,
} from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";

import { resultTx } from "@/api/db/safe-db";
import { invoiceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import {
  invoicePaymentView,
  recordInvoicePayment,
} from "@/api/lib/billing/invoice-payments";
import {
  minorUnitAmountSchema,
  resourceIdSchema,
  workspaceParams,
} from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";

const invoiceParamsSchema = workspaceParams({
  invoiceId: resourceIdSchema("invoice"),
});

/** Blank text is stored as no text. */
const optionalText = (maxChars: number) =>
  v.optional(
    v.nullable(
      v.pipe(
        v.string(),
        v.trim(),
        v.maxLength(maxChars),
        v.transform((text) => (text === "" ? null : text)),
      ),
    ),
    null,
  );

const recordPaymentBodySchema = v.object({
  amount: minorUnitAmountSchema(1),
  paidOn: apiDateSchema,
  method: v.picklist(INVOICE_PAYMENT_METHODS),
  reference: optionalText(INVOICE_PAYMENT_INPUT_LIMITS.referenceMaxChars),
  note: optionalText(INVOICE_PAYMENT_INPUT_LIMITS.noteMaxChars),
});

const recordInvoicePaymentHandler = createSafeHandler(
  {
    contract: "patch",
    description:
      "Record a payment on a finalized or sent invoice: amount in minor units of the " +
      "invoice currency, paidOn no later than today. Reaching the total marks " +
      "it paid; more than the outstanding amount is refused.",
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
    body: recordPaymentBodySchema,
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
    const payment = yield* Result.await(
      resultTx(
        safeDb,
        async (tx) =>
          await recordInvoicePayment(
            tx,
            {
              invoiceId: params.invoiceId,
              workspaceId,
              organizationId: session.activeOrganizationId,
              userId: user.id,
              now: new Date(),
              recordAuditEvent,
            },
            body,
          ),
      ),
    );
    return Result.ok(invoicePaymentView(payment));
  },
);

declareAggregateMutation(recordInvoicePaymentHandler, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default recordInvoicePaymentHandler;
