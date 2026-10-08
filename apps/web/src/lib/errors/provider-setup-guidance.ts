import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";
import type { ProviderSetupErrorCode } from "@stll/api-contract/provider-setup";

import type { TranslationKey } from "@/i18n/types";

export const PROVIDER_SETUP_GUIDANCE = {
  [PROVIDER_SETUP_ERROR_CODE.anthropicWorkspaceRequired]: {
    guidance: "organization.aiConfig.anthropicWorkspaceRequired",
    linkLabel: "organization.aiConfig.anthropicWorkspaces",
  },
} as const satisfies Record<
  ProviderSetupErrorCode,
  { guidance: TranslationKey; linkLabel: TranslationKey }
>;

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
