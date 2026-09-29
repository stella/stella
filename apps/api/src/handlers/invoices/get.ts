import { Result } from "better-result";

import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { invoiceTotals } from "@/api/handlers/invoices/invoice-lines";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const readInvoiceById = createSafeHandler(
  {
    description:
      "Read one invoice with its full detail: its lines in order with " +
      "quantity, unit price, VAT, and amounts; totals with the VAT breakdown " +
      "by rate; seller profile, buyer, dates, currency, and status; and every " +
      "attached time entry and expense with its work item. Use " +
      "invoices.list for a paginated summary without lines.",
    permissions: { workspace: ["read"] },
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

    // Totals over stored lines only; a read never writes. A draft from before
    // invoice lines has none until its first line edit materialises them
    // (`lockDraftInvoiceForLines`); its stored totalAmount still holds the sum.
    const totals = invoiceTotals(invoice.lines);
    if (totals.isErr()) {
      return Result.err(totals.error);
    }

    return Result.ok({
      ...invoice,
      lines: invoice.lines.map((line) => ({
        ...line,
        releasedAt: line.releasedAt?.toISOString() ?? null,
      })),
      totals: totals.value,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
    });
  },
);

export default readInvoiceById;
