export const AI_PROVIDER_CONFIGURATION = {
  allowed: "allowed",
  permissionRequired: "permission_required",
  accountRestricted: "account_restricted",
} as const;

export const AI_UNAVAILABLE_REASON = {
  providerNotConfigured: "provider_not_configured",
  ownKeyRequired: "own_key_required",
  memberAssignmentRequired: "member_assignment_required",
  unreadable: "unreadable",
} as const;

/** Member-visible AI availability, without provider credentials or configuration. */
export type OrganizationAIAvailability = {
  available: boolean;
  instanceProvisioned: boolean;
  orgConfigured: boolean;
  unavailableReason:
    (typeof AI_UNAVAILABLE_REASON)[keyof typeof AI_UNAVAILABLE_REASON] | null;
  providerConfiguration: (typeof AI_PROVIDER_CONFIGURATION)[keyof typeof AI_PROVIDER_CONFIGURATION];
  deferredServiceTierAvailable: boolean;
  mockAnswers: boolean;
};

export type AIProviderSettingsResolution =
  | { type: "orgSettings" }
  | { type: "unavailable"; reason: "settingsUnreadable" }
  | {
      type: "defaultProvider";
      reason: "notPermitted" | "notConfigured";
    };

type ResolveAIProviderSettingsOptions = {
  orgConfigured: boolean;
  providerConfiguration: OrganizationAIAvailability["providerConfiguration"];
  readStatus: "ready" | "unavailable";
};

/** Configuration reads never decide whether a member is entitled to use AI. */
export const resolveAIProviderSettings = ({
  orgConfigured,
  providerConfiguration,
  readStatus,
}: ResolveAIProviderSettingsOptions): AIProviderSettingsResolution => {
  if (readStatus === "unavailable") {
    return { type: "unavailable", reason: "settingsUnreadable" };
  }
  if (orgConfigured) {
    return { type: "orgSettings" };
  }
  return {
    type: "defaultProvider",
    reason:
      providerConfiguration === AI_PROVIDER_CONFIGURATION.allowed
        ? "notConfigured"
        : "notPermitted",
  };
};
