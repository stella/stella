/** Member-visible AI availability, without provider credentials or configuration. */
export type OrganizationAIAvailability = {
  available: boolean;
  instanceProvisioned: boolean;
  orgConfigured: boolean;
  deferredServiceTierAvailable: boolean;
  mockAnswers: boolean;
};
