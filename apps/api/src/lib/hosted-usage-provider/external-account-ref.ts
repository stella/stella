import type { SafeId } from "@/api/lib/branded-types";

/** The provider-side external reference of an organization's billing record. */
export const hostedExternalAccountRef = (
  organizationId: SafeId<"organization">,
): string => `stella_org_${organizationId}`;
