import { Result } from "better-result";

import { INVOICE_DETAIL_RELATIONS } from "@/api/handlers/invoices/invoice-detail";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = workspaceParams({ invoiceId: tSafeId("invoice") });

const readInvoiceById = createSafeHandler(
  {
    description:
      "Read one invoice with its full line detail: every attached time entry " +
      "with its work item, every attached expense with its work item, plus " +
      "status, dates, currency, and total. Use invoices.list for a paginated " +
      "summary without line items.",
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

    return Result.ok({
      ...invoice,
      paidAt: invoice.paidAt?.toISOString() ?? null,
      createdAt: invoice.createdAt.toISOString(),
      updatedAt: invoice.updatedAt.toISOString(),
    });
  },
);

export default readInvoiceById;
