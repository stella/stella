import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { INVOICE_STATUS, invoices } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { pickDefined } from "@/api/lib/pick-defined";

export const updateInvoiceBodySchema = t.Object({
  invoiceNumber: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  invoiceDate: t.Optional(t.String({ format: "date" })),
  dueDate: t.Optional(t.Nullable(t.String({ format: "date" }))),
  reference: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
  notes: t.Optional(t.Nullable(t.String({ maxLength: 10_000 }))),
});

type UpdateInvoiceBodySchema = Static<typeof updateInvoiceBodySchema>;

type UpdateInvoiceHandlerProps = {
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
  body: UpdateInvoiceBodySchema;
};

export const updateInvoiceHandler = async ({
  scopedDb,
  workspaceId,
  invoiceId,
  body,
}: UpdateInvoiceHandlerProps) => {
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
          eq(invoices.id, invoiceId),
          eq(invoices.workspaceId, workspaceId),
          eq(invoices.status, INVOICE_STATUS.DRAFT),
        ),
      )
      .returning({ id: invoices.id }),
  );

  if (result.length === 0) {
    return status(409, {
      message: "Invoice not found or not in draft status",
    });
  }

  return { id: result[0].id };
};
