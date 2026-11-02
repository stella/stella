import { INVOICE_ISSUE_BLOCKER } from "@stll/api-contract/billing";
import type { InvoiceIssueBlocker } from "@stll/api-contract/billing";

import type { TranslationKey } from "@/i18n/types";

/**
 * What stops an invoice from being issued, and where it is fixed: the refusal
 * toast and the composer's review step read the same entry. Total over the
 * blockers, so a new precondition cannot ship without its message and page.
 */
export const INVOICE_ISSUE_BLOCKER_FIXES = {
  [INVOICE_ISSUE_BLOCKER.sellerProfileMissing]: {
    messageKey: "errors.apiCodes.invoiceSellerProfileMissing",
    settingsLabelKey: "admin.billingProfiles",
    to: "/admin/billing",
  },
  [INVOICE_ISSUE_BLOCKER.numberSeriesMissing]: {
    messageKey: "errors.apiCodes.invoiceNumberSeriesMissing",
    settingsLabelKey: "billing.numberSeries.title",
    to: "/admin/number-series",
  },
} as const satisfies Record<
  InvoiceIssueBlocker,
  {
    messageKey: TranslationKey;
    settingsLabelKey: TranslationKey;
    to: "/admin/billing" | "/admin/number-series";
  }
>;

export const INVOICE_ISSUE_ERROR_KEYS = {
  [INVOICE_ISSUE_BLOCKER.sellerProfileMissing]:
    INVOICE_ISSUE_BLOCKER_FIXES.invoice_seller_profile_missing.messageKey,
  [INVOICE_ISSUE_BLOCKER.numberSeriesMissing]:
    INVOICE_ISSUE_BLOCKER_FIXES.invoice_number_series_missing.messageKey,
} as const satisfies Record<InvoiceIssueBlocker, TranslationKey>;
