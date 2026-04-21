import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import {
  BILLING_STATUS,
  expenses,
  INVOICE_STATUS,
  invoices,
  timeEntries,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tUuid, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const invoiceParamsSchema = workspaceParams({ invoiceId: tUuid });

const deleteInvoice = createSafeHandler(
  {
    permissions: { invoice: ["delete"] },
    params: invoiceParamsSchema,
  },
  async function* ({ safeDb, workspaceId, params }) {
    const now = new Date();

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const invoice = await tx.query.invoices.findFirst({
          where: {
            id: params.invoiceId,
            workspaceId: { eq: workspaceId },
            status: INVOICE_STATUS.DRAFT,
          },
          columns: { id: true },
        });

        if (!invoice) {
          return { ok: false as const };
        }

        await tx
          .update(timeEntries)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.invoiceId, params.invoiceId),
              eq(timeEntries.workspaceId, workspaceId),
            ),
          );

        await tx
          .update(expenses)
          .set({
            status: BILLING_STATUS.APPROVED,
            invoiceId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(expenses.invoiceId, params.invoiceId),
              eq(expenses.workspaceId, workspaceId),
            ),
          );

        await tx
          .delete(invoices)
          .where(
            and(
              eq(invoices.id, params.invoiceId),
              eq(invoices.workspaceId, workspaceId),
            ),
          );

        return { ok: true as const, deleted: true };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Invoice not found or not in draft status",
        }),
      );
    }

    return Result.ok({ deleted: txResult.deleted });
  },
);

export default deleteInvoice;
