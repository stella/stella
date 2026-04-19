import { Result } from "better-result";
import { t } from "elysia";

import { createSafeHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = t.Object({
  invoiceId: tNanoid,
});

const readInvoiceById = createSafeHandler(
  {
    permissions: { workspace: ["read"] },
    params: invoiceParamsSchema,
  },
  async function* ({ safeDb, workspaceId, params }) {
    const invoice = yield* Result.await(
      safeDb((tx) =>
        tx.query.invoices.findFirst({
          where: {
            id: params.invoiceId,
            workspaceId: { eq: workspaceId },
          },
          with: {
            timeEntries: {
              columns: {
                id: true,
                matterId: true,
                dateWorked: true,
                billedMinutes: true,
                rateAtEntry: true,
                currency: true,
                narrative: true,
                invoiceNarrative: true,
                status: true,
              },
              with: {
                matter: {
                  columns: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
            expenses: {
              columns: {
                id: true,
                matterId: true,
                dateIncurred: true,
                amount: true,
                currency: true,
                category: true,
                description: true,
                invoiceDescription: true,
                billable: true,
                markup: true,
              },
              with: {
                matter: {
                  columns: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
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
