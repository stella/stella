import type { billingDraftUserSettings } from "@/api/db/schema";

/** The caller's own AI drafting consent and preference, as the settings
 * endpoint reports them, for the account export. */
export const toBillingDraftSettingsAccountExport = ({
  consentAt,
  preference,
  updatedAt,
}: typeof billingDraftUserSettings.$inferSelect) => ({
  consent: consentAt ? ("granted" as const) : ("revoked" as const),
  consentAt: consentAt?.toISOString() ?? null,
  preference,
  updatedAt: updatedAt.toISOString(),
});
