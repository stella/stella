import { Result } from "better-result";

import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { readInvoiceTotals } from "@/api/handlers/invoices/invoice-lines";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const readInvoiceById = createSafeHandler(
  {
    description:
      "Read one invoice with its full detail: its lines in order with " +
      "quantity, unit price, VAT, and amounts; totals with the VAT breakdown " +
      "by rate; document type, original invoice id, seller profile, buyer, dates, currency, and status; and every " +
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
            workspaceId: { eq: workspaceId },
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
    if (totals.isErr()) {
      return Result.err(totals.error);
    }

    return Result.ok({
      ...invoice,
      netAmount: totals.value.netAmountMinor,
      vatAmount: totals.value.vatAmountMinor,
      lines: invoice.lines.map((line) => ({
        ...line,
        releasedAt: line.releasedAt?.toISOString() ?? null,
      })),
      totals: totals.value,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      finalizedAt: invoice.finalizedAt?.toISOString() ?? null,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
    });
  },
);

export default readInvoiceById;
