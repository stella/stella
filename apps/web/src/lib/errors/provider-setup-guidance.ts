import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";
import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

import type { TranslationKey } from "@/i18n/types";

type NamespacedTranslationKey<
  Key,
  Namespace extends string,
> = Key extends `${Namespace}.${infer ScopedKey}` ? ScopedKey : never;

type AiConfigTranslationKey = NamespacedTranslationKey<
  TranslationKey,
  "organization.aiConfig"
>;

export type ProviderSetupGuidance = {
  guidance: AiConfigTranslationKey;
  linkLabel: AiConfigTranslationKey;
};

const PROVIDER_SETUP_GUIDANCE = {
  [PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired]: {
    guidance: "anthropicWorkspaceRequired",
    linkLabel: "anthropicWorkspaces",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicSubscriptionToken]: {
    guidance: "anthropicSubscriptionToken",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicNoCredits]: {
    guidance: "anthropicNoCredits",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicKeyDisabled]: {
    guidance: "anthropicKeyDisabled",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.anthropicOrganizationRestricted]: {
    guidance: "anthropicOrganizationRestricted",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiProjectOrganizationMismatch]: {
    guidance: "openaiProjectOrganizationMismatch",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota]: {
    guidance: "openaiInsufficientQuota",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.googleApiNotEnabled]: {
    guidance: "googleApiNotEnabled",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.googleKeyRestricted]: {
    guidance: "googleKeyRestricted",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.openrouterNoCredits]: {
    guidance: "openrouterNoCredits",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.azureModelNotEnabled]: {
    guidance: "azureModelNotEnabled",
    linkLabel: "providerSetupConsole",
  },
  [PROVIDER_SETUP_ERROR_CODE.bedrockModelNotEnabled]: {
    guidance: "bedrockModelNotEnabled",
    linkLabel: "providerSetupConsole",
  },
} as const satisfies Record<ProviderSetupErrorCode, ProviderSetupGuidance>;

export const providerSetupGuidance = (code: string | undefined) => {
  for (const knownCode of Object.values(PROVIDER_SETUP_ERROR_CODE)) {
    if (code === knownCode) {
      return {
        ...PROVIDER_SETUP_GUIDANCE[knownCode],
        ...PROVIDER_SETUP_ERROR_CATALOGUE[knownCode],
      };
    }
  }
  return null;
};
