import { and, eq } from "drizzle-orm";
import { status, t, type Static } from "elysia";

import { db } from "@/api/db";
import { INVOICE_STATUS, invoices } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

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
  workspaceId: SafeId<"workspace">;
  invoiceId: string;
  body: UpdateInvoiceBodySchema;
};

export const updateInvoiceHandler = async ({
  workspaceId,
  invoiceId,
  body,
}: UpdateInvoiceHandlerProps) => {
  const now = new Date();

  const set: Record<string, unknown> = { updatedAt: now };

  if (body.invoiceNumber !== undefined) {
    set.invoiceNumber = body.invoiceNumber;
  }
  if (body.invoiceDate !== undefined) {
    set.invoiceDate = body.invoiceDate;
  }
  if (body.dueDate !== undefined) {
    set.dueDate = body.dueDate;
  }
  if (body.reference !== undefined) {
    set.reference = body.reference;
  }
  if (body.notes !== undefined) {
    set.notes = body.notes;
  }
  if (body.currency !== undefined) {
    set.currency = body.currency;
  }

  const result = await db
    .update(invoices)
    .set(set)
    .where(
      and(
        eq(invoices.id, invoiceId),
        eq(invoices.workspaceId, workspaceId),
        eq(invoices.status, INVOICE_STATUS.DRAFT),
      ),
    )
    .returning({ id: invoices.id });

  if (result.length === 0) {
    return status(409, {
      message: "Invoice not found or not in draft status",
    });
  }

  return { id: result[0].id };
};
