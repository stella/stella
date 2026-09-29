import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { type Static, t } from "elysia";

import type { InvoiceDocumentType } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { INVOICE_STATUS, invoices } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const tInvoiceDocumentType = t.Union([
  t.Literal("invoice"),
  t.Literal("advance"),
  t.Literal("credit_note"),
]);
true satisfies [InvoiceDocumentType] extends [
  Static<typeof tInvoiceDocumentType>,
]
  ? [Static<typeof tInvoiceDocumentType>] extends [InvoiceDocumentType]
    ? true
    : never
  : never;

type ValidateInvoiceDocumentOptions = {
  workspaceId: SafeId<"workspace">;
  documentType: InvoiceDocumentType;
  originalInvoiceId: SafeId<"invoice"> | null;
  currency: string;
  totalAmount?: number;
};

/** The linked document is authorized and stable until this transaction commits. */
export const validateInvoiceDocument = async (
  tx: Transaction,
  {
    workspaceId,
    documentType,
    originalInvoiceId,
    currency,
    totalAmount,
  }: ValidateInvoiceDocumentOptions,
): Promise<Result<void, HandlerError>> => {
  if (documentType !== "credit_note") {
    return originalInvoiceId === null
      ? Result.ok(undefined)
      : Result.err(
          new HandlerError({
            status: 422,
            message: "Only a credit note can reference an original invoice",
          }),
        );
  }
  if (originalInvoiceId === null) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "A credit note requires an original invoice",
      }),
    );
  }
  const rows = await tx
    .select({
      status: invoices.status,
      documentType: invoices.documentType,
      currency: invoices.currency,
      totalAmount: invoices.totalAmount,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.id, originalInvoiceId),
        eq(invoices.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("share");
  const original = rows.at(0);
  if (!original) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Original invoice not found in this matter",
      }),
    );
  }
  if (original.documentType === "credit_note") {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "A credit note cannot reference another credit note",
      }),
    );
  }
  if (
    original.status !== INVOICE_STATUS.FINALIZED &&
    original.status !== INVOICE_STATUS.SENT &&
    original.status !== INVOICE_STATUS.PAID
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Original invoice must be finalized, sent, or paid",
      }),
    );
  }
  if (original.currency !== currency) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Credit note currency must match its original invoice",
      }),
    );
  }
  if (
    totalAmount !== undefined &&
    Math.abs(totalAmount) > original.totalAmount
  ) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "Credit note total cannot exceed its original invoice",
      }),
    );
  }
  return Result.ok(undefined);
};
