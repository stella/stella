import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import { INVOICE_LINE_SOURCE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { invoiceLines, INVOICE_BILLING_PURPOSE } from "@/api/db/schema";
import {
  lockBillingArrangement,
  readBillingUsage,
} from "@/api/lib/billing/arrangements";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const flatFeeInvoiceRefusal = () =>
  new HandlerError({
    status: 409,
    code: "flat_fee_invoice_locked",
    message: "A flat-fee invoice must retain its single snapshotted fee line",
    hint: "Remove or void the invoice to release its covered entries; create a new invoice for a different fee.",
  });

type CheckInvoiceBillingArrangementOptions = {
  invoiceId: SafeId<"invoice">;
  workspaceId: SafeId<"workspace">;
};

/** Caller owns the matter lock before the invoice lock; refusal aborts resultTx. */
export const checkInvoiceBillingArrangement = async (
  tx: Transaction,
  { invoiceId, workspaceId }: CheckInvoiceBillingArrangementOptions,
) => {
  const invoice = await tx.query.invoices.findFirst({
    where: { id: { eq: invoiceId }, workspaceId: { eq: workspaceId } },
  });
  if (!invoice) {
    return panic("The locked invoice disappeared during billing validation");
  }
  const arrangement = await lockBillingArrangement(tx, workspaceId);
  if (invoice.billingMode === "flat_fee") {
    const lines = await tx
      .select({
        purpose: invoiceLines.billingPurpose,
        source: invoiceLines.source,
        quantity: invoiceLines.quantity,
        unitPrice: invoiceLines.unitPrice,
        netAmount: invoiceLines.netAmount,
      })
      .from(invoiceLines)
      .where(
        and(
          eq(invoiceLines.invoiceId, invoiceId),
          eq(invoiceLines.workspaceId, workspaceId),
        ),
      )
      .limit(2);
    const fee = lines.at(0);
    if (
      invoice.documentType !== "invoice" ||
      lines.length !== 1 ||
      !fee ||
      fee.purpose !== INVOICE_BILLING_PURPOSE.FLAT_FEE ||
      fee.source !== INVOICE_LINE_SOURCE.MANUAL ||
      Number(fee.quantity) !== 1 ||
      fee.unitPrice !== invoice.flatFeeAmount ||
      fee.netAmount !== invoice.flatFeeAmount
    ) {
      return Result.err(flatFeeInvoiceRefusal());
    }
    return Result.ok(undefined);
  }
  if (
    !arrangement ||
    arrangement.mode !== "hourly" ||
    arrangement.capAmount === null ||
    invoice.documentType === "credit_note"
  ) {
    return Result.ok(undefined);
  }
  const [amount] = await tx
    .select({
      value: sql<string>`COALESCE(SUM(${invoiceLines.netAmount}), 0)::text`,
      count: sql<string>`COUNT(*)::text`,
    })
    .from(invoiceLines)
    .where(
      and(
        eq(invoiceLines.invoiceId, invoiceId),
        eq(invoiceLines.workspaceId, workspaceId),
        eq(invoiceLines.source, INVOICE_LINE_SOURCE.TIME_ENTRY),
        isNull(invoiceLines.releasedAt),
      ),
    );
  if (!amount) {
    return panic("Invoice time charge aggregate returned no row");
  }
  const candidate = BigInt(amount.value);
  const usage = await readBillingUsage(tx, {
    workspaceId,
    currency: arrangement.currency,
    excludeInvoiceId: invoiceId,
  });
  if (
    (BigInt(amount.count) > 0n && invoice.currency !== arrangement.currency) ||
    usage.currencyMismatch
  ) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "billing_currency_mismatch",
        message: "Matter billing usage must use the arrangement currency",
        hint: "Resolve the matter's mixed-currency time charges before invoicing.",
      }),
    );
  }
  if (usage.billedAmount + candidate > BigInt(arrangement.capAmount)) {
    return Result.err(
      new HandlerError({
        status: 409,
        code: "billing_cap_exceeded",
        message: "Invoice time charges exceed the matter's remaining cap",
        hint: "Remove time charges or change the billing cap before invoicing; entries are never automatically written down.",
      }),
    );
  }
  return Result.ok(undefined);
};
