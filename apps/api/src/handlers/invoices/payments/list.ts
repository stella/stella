import { Result } from "better-result";

import type { invoicePayments } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import {
  invoicePaymentAmounts,
  invoicePaymentView,
  paidAmountOf,
  readInvoicePayments,
} from "@/api/lib/billing/invoice-payments";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type InvoicePaymentRow = typeof invoicePayments.$inferSelect;
type InvoicePaymentItem = ReturnType<typeof invoicePaymentView>;

const UNPROJECTED_PAYMENT_COLUMNS = [
  // Tenant scope is supplied by the authorized invoice route.
  "organizationId",
  // Repair provenance is server-owned bookkeeping, not payment input or output.
  "origin",
] as const satisfies readonly (keyof InvoicePaymentRow)[];

type MissingPaymentColumn = UnprojectedColumns<
  InvoicePaymentRow,
  InvoicePaymentItem,
  (typeof UNPROJECTED_PAYMENT_COLUMNS)[number]
>;
type UnexpectedPaymentColumn = UnbackedProjectionKeys<
  InvoicePaymentRow,
  InvoicePaymentItem,
  (typeof UNPROJECTED_PAYMENT_COLUMNS)[number]
>;

true satisfies MissingPaymentColumn extends never ? true : never;
true satisfies UnexpectedPaymentColumn extends never ? true : never;

const invoiceParamsSchema = workspaceParams({
  invoiceId: resourceIdSchema("invoice"),
});

const listInvoicePayments = createSafeHandler(
  {
    contract: "patch",
    description:
      "List an invoice's payments oldest first, voided ones included, with " +
      "its paid and outstanding amounts in minor units.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      readClass: "tenant",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "read",
    params: invoiceParamsSchema,
  },
  async function* ({ safeDb, workspaceId, params }) {
    const read = yield* Result.await(
      safeDb(async (tx) => {
        const invoice = await tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
            RAW: (table) => invoiceInMatter(table, workspaceId),
          },
          columns: { totalAmount: true, currency: true },
        });
        return invoice === undefined
          ? undefined
          : {
              invoice,
              payments: await readInvoicePayments(tx, params.invoiceId),
            };
      }),
    );
    if (!read) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice not found" }),
      );
    }
    return Result.ok({
      currency: read.invoice.currency,
      ...invoicePaymentAmounts({
        totalAmount: read.invoice.totalAmount,
        paidAmount: paidAmountOf(read.payments),
      }),
      items: read.payments.map(invoicePaymentView),
    });
  },
);

export default listInvoicePayments;
