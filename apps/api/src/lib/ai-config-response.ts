import { panic } from "better-result";

import { normalizeProviderRegion } from "@/api/lib/ai-config";
import type { DataRegion, OrgAIProviderConfig } from "@/api/lib/ai-config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export type ProviderResponseExtras = {
  endpoint?: string;
  apiVersion?: string;
};

export const AI_CONFIG_UNREADABLE_ERROR_CODE = "ai_config_stored_unreadable";

/**
 * The org has a stored AI config that cannot be decrypted. Every caller must
 * fail closed on it, so both settings handlers raise the identical error:
 * answering the read with `configured: false` makes an encryption-key problem
 * look like "nothing configured" and prompts for re-entry, and merging an
 * update onto an empty base would drop the providers the request body omits.
 */
export const storedAIConfigUnreadableError = (cause: unknown) =>
  new HandlerError({
    code: AI_CONFIG_UNREADABLE_ERROR_CODE,
    status: 503,
    message: "Stored AI configuration could not be read",
    cause,
  });

export const providerResponseRegion = (
  providerConfig: OrgAIProviderConfig,
): DataRegion => {
  switch (providerConfig.provider) {
    case "azure_foundry":
    case "huggingface":
      return "global";
    case "google":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "bedrock":
    case "mistral":
    case "openai_compatible":
      return normalizeProviderRegion(
        providerConfig.provider,
        providerConfig.region,
      );
    default:
      return panic("Unsupported AI provider configuration");
  }
};

export const providerResponseExtras = (
  providerConfig: OrgAIProviderConfig,
): ProviderResponseExtras => {
  switch (providerConfig.provider) {
    case "azure_foundry":
      return {
        endpoint: providerConfig.baseURL,
        ...(providerConfig.apiVersion
          ? { apiVersion: providerConfig.apiVersion }
          : {}),
      };
    case "huggingface":
      return { endpoint: providerConfig.baseURL };
    case "google":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "bedrock":
    case "mistral":
    case "openai_compatible":
      return {};
    default:
      return panic("Unsupported AI provider configuration");
  }
};
