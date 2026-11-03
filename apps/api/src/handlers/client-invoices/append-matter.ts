import { Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import { billCreatedDraft } from "@/api/lib/billing/invoice-create-operation";
import { resolveInvoicePrefill } from "@/api/lib/billing/invoice-prefill";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type AppendClientMatterOptions = Omit<
  Parameters<typeof billCreatedDraft>[1],
  "auditAction" | "vat" | "flatFee" | "documentType" | "originalInvoiceId"
> & { supplyDate: string };

/** All matters use the same invoice supply date, seller and client VAT decision. */
export const appendClientInvoiceMatter = async (
  tx: Transaction,
  { supplyDate, ...options }: AppendClientMatterOptions,
) => {
  const prefill = await resolveInvoicePrefill(tx, {
    organizationId: options.organizationId,
    workspaceId: options.workspaceId,
    sellerProfileId: options.body.sellerProfileId,
    supplyDate,
  });
  if (prefill.vat.reason === "no_vat_rate") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "No VAT rate is in force on the invoice supply date",
      }),
    );
  }
  return await billCreatedDraft(tx, {
    ...options,
    auditAction: AUDIT_ACTION.UPDATE,
    flatFee: null,
    vat: {
      vatTreatment: prefill.vat.vatTreatment,
      vatRateBps: prefill.vat.vatRateBps,
      exemptionReason: null,
    },
    documentType: "invoice",
    originalInvoiceId: null,
  });
};
