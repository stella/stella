import type { OrganizationAIAvailability } from "@stll/api-contract/organization-ai-availability";

// Complete availability responses share the contract checked by the API, so a
// field added to the endpoint fails every test fixture at compile time instead
// of reaching the gate as `undefined`.

export const aiAvailableResponse = (): OrganizationAIAvailability => ({
  available: true,
  instanceProvisioned: true,
  orgConfigured: false,
  unavailableReason: null,
  providerConfiguration: "allowed",
  deferredServiceTierAvailable: false,
  mockAnswers: false,
});

type AIUnavailableResponseOptions = Partial<
  Pick<
    OrganizationAIAvailability,
    "providerConfiguration" | "deferredServiceTierAvailable"
  >
> & {
  unavailableReason?: NonNullable<
    OrganizationAIAvailability["unavailableReason"]
  >;
};

export const aiUnavailableResponse = ({
  providerConfiguration = "allowed",
  unavailableReason = "provider_not_configured",
  deferredServiceTierAvailable = false,
}: AIUnavailableResponseOptions = {}): OrganizationAIAvailability => ({
  available: false,
  instanceProvisioned: false,
  orgConfigured: false,
  unavailableReason,
  providerConfiguration,
  deferredServiceTierAvailable,
  mockAnswers: false,
});
