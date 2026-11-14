import { panic } from "better-result";

import { INVOICE_ISSUE_BLOCKER } from "@stll/api-contract/billing";
import type { InvoiceIssueBlocker } from "@stll/api-contract/billing";
import type { InvoiceDocumentType } from "@stll/invoicing";

import type { Transaction } from "@/api/db/root";
import { findDefaultNumberSeries } from "@/api/lib/billing/number-series";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/** The parts of an invoice that decide whether it can be issued. */
type InvoiceIssueCandidate = {
  documentType: InvoiceDocumentType;
  sellerProfileId: SafeId<"sellerProfile"> | null;
  /** A number set by hand, or kept after reverting, needs no series. */
  invoiceNumber: string | null;
  /** An invoice issued before keeps its content when it is issued again. */
  finalizedAt: Date | null;
};

/**
 * Everything that stops this invoice from being issued, in the order issuing
 * checks it. The one owner of these preconditions: finalizing refuses on the
 * first, and the invoice prefill reports all of them so the composer offers
 * "Issue invoice" only when issuing can succeed.
 */
export const readInvoiceIssueBlockers = async (
  tx: Transaction,
  candidate: InvoiceIssueCandidate,
): Promise<InvoiceIssueBlocker[]> => {
  const blockers: InvoiceIssueBlocker[] = [];
  if (candidate.sellerProfileId === null && candidate.finalizedAt === null) {
    blockers.push(INVOICE_ISSUE_BLOCKER.sellerProfileMissing);
  }
  if (
    candidate.invoiceNumber === null &&
    (await findDefaultNumberSeries(
      tx,
      candidate.documentType,
      candidate.sellerProfileId,
    )) === undefined
  ) {
    blockers.push(INVOICE_ISSUE_BLOCKER.numberSeriesMissing);
  }
  return blockers;
};

/** The refusal issuing answers with for a blocker. */
export const invoiceIssueBlockerError = (
  blocker: InvoiceIssueBlocker,
): HandlerError => {
  switch (blocker) {
    case INVOICE_ISSUE_BLOCKER.sellerProfileMissing:
      return new HandlerError({
        status: 409,
        code: blocker,
        message: "The invoice has no seller profile",
        hint: "Create a seller profile (seller-profiles.create), set its id as sellerProfileId with invoices.update, then finalize again.",
      });
    case INVOICE_ISSUE_BLOCKER.numberSeriesMissing:
      return new HandlerError({
        status: 409,
        code: blocker,
        message: "No default number series configured for this document type",
        hint: "Create a number series (number-series.create) for this documentType and this seller or all sellers, set it as default, then finalize again.",
      });
    default:
      blocker satisfies never;
      return panic(`Unknown invoice issue blocker: ${String(blocker)}`);
  }
};
