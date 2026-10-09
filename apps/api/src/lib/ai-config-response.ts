import { panic } from "better-result";

import { normalizeProviderRegion } from "@/api/lib/ai-config";
import type {
  DataRegion,
  OrgAIProviderConfig,
  OrgDecisionModelConfig,
} from "@/api/lib/ai-config";
import { maskApiKey } from "@/api/lib/ai-config-crypto";
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

export const AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE =
  "ai_member_assignment_required";

export const memberAssignmentRequiredError = () =>
  new HandlerError({
    code: AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE,
    status: 403,
    message:
      "AI is available only to members with an assigned seat in this " +
      "organization. Ask an organization admin to assign you one.",
  });

/**
 * For call sites that start AI work without resolving a model themselves
 * (run starters whose worker loads the config again, streams that never read
 * the instance fallback): refuses only a member the organization does not
 * admit to AI work, so their other behavior is unchanged.
 */
export const memberAIAccessError = (
  status: OrgAIConfigStatus,
): HandlerError<403> | null =>
  status === ORG_AI_CONFIG_STATUS.memberAssignmentRequired
    ? memberAssignmentRequiredError()
    : null;

/**
 * The error an AI call site returns when the org's null config must not fall
 * through to the instance provider, or the requesting member may not run AI
 * work at all; null when it may proceed.
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
    case ORG_AI_CONFIG_STATUS.memberAssignmentRequired:
      return memberAssignmentRequiredError();
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

/** The shared read/save projection preserves each provider's configuration. */
export const decisionModelResponse = (
  decision: OrgDecisionModelConfig | null,
) => {
  if (decision === null) {
    return null;
  }
  switch (decision.provider) {
    case "typesafe":
      return {
        provider: decision.provider,
        apiKeyMasked: maskApiKey(decision.apiKey),
        modelId: decision.modelId,
      };
    case "openai":
      return {
        provider: decision.provider,
        apiKeyMasked:
          decision.apiKey === undefined
            ? undefined
            : maskApiKey(decision.apiKey),
        region: decision.region,
        modelId: decision.modelId,
      };
    default:
      decision satisfies never;
      return panic("Unhandled decision response provider");
  }
};
