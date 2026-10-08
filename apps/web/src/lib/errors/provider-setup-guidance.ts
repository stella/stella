import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";
import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

import type { TranslationKey } from "@/i18n/types";

const PROVIDER_SETUP_GUIDANCE = {
  [PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired]: {
    guidance: "organization.aiConfig.anthropicWorkspaceRequired",
    linkLabel: "organization.aiConfig.anthropicWorkspaces",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken]: {
    guidance: "organization.aiConfig.anthropicSubscriptionToken",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits]: {
    guidance: "organization.aiConfig.anthropicNoCredits",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicKeyDisabled]: {
    guidance: "organization.aiConfig.anthropicKeyDisabled",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicOrganizationRestricted]: {
    guidance: "organization.aiConfig.anthropicOrganizationRestricted",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiProjectOrganizationMismatch]: {
    guidance: "organization.aiConfig.openaiProjectOrganizationMismatch",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota]: {
    guidance: "organization.aiConfig.openaiInsufficientQuota",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.googleApiNotEnabled]: {
    guidance: "organization.aiConfig.googleApiNotEnabled",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.googleKeyRestricted]: {
    guidance: "organization.aiConfig.googleKeyRestricted",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.openrouterNoCredits]: {
    guidance: "organization.aiConfig.openrouterNoCredits",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.azureModelNotEnabled]: {
    guidance: "organization.aiConfig.azureModelNotEnabled",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.bedrockModelNotEnabled]: {
    guidance: "organization.aiConfig.bedrockModelNotEnabled",
    linkLabel: "organization.aiConfig.providerSetupConsole",
  },
} as const satisfies Record<
  ProviderSetupErrorCode,
  { guidance: TranslationKey; linkLabel: TranslationKey }
>;

export const providerSetupGuidance = (code: string | undefined) => {
  for (const knownCode of Object.values(PROVIDER_SETUP_ERROR_CODE)) {
    if (code === knownCode) {
      return {
        code: knownCode,
        ...PROVIDER_SETUP_GUIDANCE[knownCode],
        ...PROVIDER_SETUP_ERROR_CATALOGUE[knownCode],
      };
    }
  }
  return null;
};
