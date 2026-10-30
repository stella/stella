import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { INVOICE_DETAIL_RELATIONS } from "@/api/lib/billing/invoice-detail";
import { readInvoiceTotals } from "@/api/lib/billing/invoice-lines";
import {
  invoicePaymentAmounts,
  invoicePaymentView,
  paidAmountOf,
} from "@/api/lib/billing/invoice-payments";
import { invoiceInMatter } from "@/api/lib/billing/invoice-scope";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = workspaceParams({
  invoiceId: resourceIdSchema("invoice"),
});

const readInvoiceById = createSafeHandler(
  {
    contract: "patch",
    description:
      "Read one invoice with its full detail: its lines in order with " +
      "quantity, unit price, VAT, and amounts; totals with the VAT breakdown " +
      "by rate; document type, original invoice id, seller profile, buyer, dates, currency, and status; " +
      "its payments with the paid and outstanding amounts; and every " +
      "attached time entry and expense with its work item. An invoice from " +
      "before invoice lines lists no lines for its attached entries until " +
      "its first line edit; its totals still count them. Use " +
      "invoices.list for a paginated summary without lines.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: { type: "covered", by: "list_invoices" },
    access: "read",
    params: invoiceParamsSchema,
  },
  async function* ({ safeDb, workspaceId, params }) {
    const invoice = yield* Result.await(
      safeDb((tx) =>
        tx.query.invoices.findFirst({
          where: {
            id: { eq: params.invoiceId },
            RAW: (table) => invoiceInMatter(table, workspaceId),
          },
          with: INVOICE_DETAIL_RELATIONS,
        }),
      ),
    );

    if (!invoice) {
      return Result.err(
        new HandlerError({ status: 404, message: "Invoice not found" }),
      );
    }

    // A read never writes: an invoice from before invoice lines lists no lines
    // for its attached entries until its first line edit materialises them
    // (`lockDraftInvoiceForLines`), and its totals count them in memory.
    const totals = readInvoiceTotals(invoice);

    return Result.ok({
      ...invoice,
      netAmount: totals.netAmountMinor,
      vatAmount: totals.vatAmountMinor,
      lines: invoice.lines.map((line) => ({
        ...line,
        releasedAt: line.releasedAt?.toISOString() ?? null,
      })),
      totals,
      payments: invoice.payments.map(invoicePaymentView),
      ...invoicePaymentAmounts({
        totalAmount: invoice.totalAmount,
        paidAmount: paidAmountOf(invoice.payments),
      }),
      sentAt: invoice.sentAt?.toISOString() ?? null,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      finalizedAt: invoice.finalizedAt?.toISOString() ?? null,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
    });
  },
);

export default readInvoiceById;
