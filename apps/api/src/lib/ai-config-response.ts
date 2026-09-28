import { panic } from "better-result";

import { normalizeProviderRegion } from "@/api/lib/ai-config";
import type { DataRegion, OrgAIProviderConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { OrgAIConfigStatus } from "@/api/lib/ai-config-loader-core";
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

export const ownAIKeyRequiredError = () =>
  new HandlerError({
    status: 403,
    message:
      "AI is not available for this organization without its own key. " +
      "Configure an organization-wide AI key in organization settings.",
  });

/**
 * The error an AI call site returns when the org's null config must not fall
 * through to the instance provider, or null when it may.
 */
export const orgAIConfigStatusError = (
  status: OrgAIConfigStatus,
): HandlerError | null => {
  switch (status) {
    case ORG_AI_CONFIG_STATUS.ok:
      return null;
    case ORG_AI_CONFIG_STATUS.unreadable:
      return storedAIConfigUnreadableError(undefined);
    case ORG_AI_CONFIG_STATUS.ownKeyRequired:
      return ownAIKeyRequiredError();
    default: {
      status satisfies never;
      return panic(
        `Unhandled organization AI config status: ${String(status)}`,
      );
    }
  }
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
