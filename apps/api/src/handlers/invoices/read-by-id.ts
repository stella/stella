import { status } from "elysia";

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";

type ReadInvoiceByIdHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
};

export const readInvoiceByIdHandler = async ({
  scopedDb,
  workspaceId,
  invoiceId,
}: ReadInvoiceByIdHandlerProps) => {
  const invoice = await scopedDb((tx) =>
    tx.query.invoices.findFirst({
      where: {
        id: invoiceId,
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
  );

  if (!invoice) {
    return status(404, { message: "Invoice not found" });
  }

  return {
    ...invoice,
    paidAt: invoice.paidAt?.toISOString() ?? null,
    createdAt: invoice.createdAt.toISOString(),
    updatedAt: invoice.updatedAt.toISOString(),
  };
};
