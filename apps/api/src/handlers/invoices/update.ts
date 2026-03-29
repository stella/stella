import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";

import { INVOICE_STATUS, invoices } from "@/api/db/schema";
import { createHandler } from "@/api/lib/api-handlers";
import { tNanoid } from "@/api/lib/custom-schema";
import { pickDefined } from "@/api/lib/pick-defined";

export const updateInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  invoiceDate: t.Optional(t.String({ format: "date" })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

const invoiceParamsSchema = t.Object({
  invoiceId: tNanoid,
});

const updateInvoice = createHandler(
  {
    permissions: { invoice: ["update"] },
    params: invoiceParamsSchema,
    body: updateInvoiceBodySchema,
  },
  async ({ scopedDb, workspaceId, params, body }) => {
    const set = {
      ...pickDefined(body, [
        "invoiceNumber",
        "invoiceDate",
        "dueDate",
        "reference",
        "notes",
        "currency",
      ]),
      updatedAt: new Date(),
    };

    const result = await scopedDb((tx) =>
      tx
        .update(invoices)
        .set(set)
        .where(
          and(
            eq(invoices.id, params.invoiceId),
            eq(invoices.workspaceId, workspaceId),
            eq(invoices.status, INVOICE_STATUS.DRAFT),
          ),
        )
        .returning({ id: invoices.id }),
    );

    const updated = result.at(0);
    if (!updated) {
      return status(409, {
        message: "Invoice not found or not in draft status",
      });
    }
    return { id: updated.id };
  },
);

export default updateInvoice;
