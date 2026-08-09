import { panic } from "better-result";

import { normalizeProviderRegion } from "@/api/lib/ai-config";
import type { DataRegion, OrgAIProviderConfig } from "@/api/lib/ai-config";

export type ProviderResponseExtras = {
  endpoint?: string;
  apiVersion?: string;
};

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
