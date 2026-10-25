/** Member-visible AI availability, without provider credentials or configuration. */
export type OrganizationAIAvailability = {
  available: boolean;
  instanceProvisioned: boolean;
  orgConfigured: boolean;
  unavailableReason:
    | "provider_not_configured"
    | "own_key_required"
    | "member_assignment_required"
    | "unreadable"
    | null;
  providerConfiguration:
    "allowed" | "permission_required" | "account_restricted";
  deferredServiceTierAvailable: boolean;
  mockAnswers: boolean;
};
