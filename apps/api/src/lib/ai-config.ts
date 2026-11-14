import { panic } from "better-result";

import {
  BYOK_MODEL_OPTIONS,
  MODEL_OVERRIDE_GROUP_TASK,
  MODEL_TASK_OVERRIDE_GROUP,
  resolveDefaultModel,
  resolveWorkingBYOKModelForTask,
} from "@stll/ai-catalog";
import type {
  AIProvider,
  BYOKProvider,
  DecisionModelProvider,
  ModelOverrideGroup,
  ModelTask,
} from "@stll/ai-catalog";

import type { UsageServiceTier } from "@/api/db/schema";

export type DataRegion = "eu" | "global" | "ch";
export type AIRequestServiceTier = UsageServiceTier;

export const STELLA_PROVIDER_METADATA_KEY = "stella";
export const SERVICE_TIER_PROVIDER_METADATA_KEY = "effectiveServiceTier";
export const FALLBACK_FROM_SERVICE_TIER_PROVIDER_METADATA_KEY =
  "fallbackFromServiceTier";

/**
 * Check whether a provider supports regional routing.
 * Used at config save time to reject unsupported
 * provider + region combinations.
 */
export const supportsRegion = (_provider: AIProvider): boolean => false;

/**
 * Sampling temperature per logical role.
 *
 * Legal work prioritizes determinism over creativity. Every role
 * is pinned to 0 so the same input yields the same output.
 */
export const getTemperatureForTask = (_task: ModelTask): number => 0;

/**
 * Whether stella may annotate this AI request with prompt-cache
 * markers. `reason: "org-disabled"` means the org turned the
 * setting off; future variants (e.g. ZDR) compose into the
 * disabled case.
 *
 * When `enabled`, `scopeKey` carries an optional stable string
 * used as the OpenAI `prompt_cache_key` (cache-shard routing) and surfaces in
 * telemetry. `null` means no routing key; opportunistic caching only.
 */
export type CachingDecision =
  | { enabled: false; reason: "org-disabled" }
  | { enabled: true; ttl: "5m"; scopeKey: string | null };

export const resolveCaching = ({
  promptCachingEnabled,
  scopeKey,
}: {
  promptCachingEnabled: boolean;
  task: ModelTask;
  scopeKey: string | null;
}): CachingDecision => {
  if (!promptCachingEnabled) {
    return { enabled: false, reason: "org-disabled" };
  }
  return { enabled: true, ttl: "5m", scopeKey };
};

export type OrgAIConfig = {
  providers: OrgAIProviderConfig[];
  /**
   * Per-role model selection. Every role must resolve to a
   * configured provider. Additional configured providers may
   * be stored for later assignment.
   */
  overrideModels: Partial<
    Record<ModelOverrideGroup, OrgAIModelSelection | undefined>
  > | null;
  /**
   * The model typed decisions go to (see `lib/decisions/decide.ts`). It is
   * not one of the generative roles: a decision model answers choice and
   * yes/no questions with probabilities and writes no text, so it has its
   * own provider space. OpenAI may reuse the org's generative key. Null means
   * the org has none; the instance's, if any, answers then.
   */
  decision: OrgDecisionModelConfig | null;
};

export { DECISION_MODEL_PROVIDERS } from "@stll/ai-catalog";
export type { DecisionModelProvider };

export type OrgDecisionModelConfig =
  | { provider: "typesafe"; apiKey: string; modelId: string }
  | {
      provider: "openai";
      /** Absent reuses the organization's generative OpenAI key. */
      apiKey?: string | undefined;
      region: "eu" | "global";
      modelId: string;
    };

export type StandardOrgAIProviderConfig = {
  provider: Exclude<AIProvider, "azure_foundry" | "huggingface" | "anthropic">;
  /** Decrypted API key. */
  apiKey: string;
  /** Stored endpoint selection; validated against the provider on save. */
  region?: DataRegion | undefined;
};

type AnthropicOrgAIProviderConfig = {
  provider: "anthropic";
  apiKey: string;
  /** Stored in the encrypted configuration alongside the key. */
  anthropicWorkspaceId?: string | undefined;
  region?: DataRegion | undefined;
};

export type AzureFoundryOrgAIProviderConfig = {
  provider: "azure_foundry";
  /** Decrypted API key. */
  apiKey: string;
  /** Normalized Azure AI Foundry baseURL, without the trailing `/v1`. */
  baseURL: string;
  apiVersion?: string | undefined;
};

export type HuggingFaceOrgAIProviderConfig = {
  provider: "huggingface";
  /** Decrypted API key (HF user token or Inference Endpoint token). */
  apiKey: string;
  /**
   * OpenAI-compatible base URL of the Inference Endpoint
   * (e.g. https://<id>.endpoints.huggingface.cloud/v1).
   */
  baseURL: string;
};

export type OrgAIProviderConfig =
  | StandardOrgAIProviderConfig
  | AnthropicOrgAIProviderConfig
  | AzureFoundryOrgAIProviderConfig
  | HuggingFaceOrgAIProviderConfig;

export type OrgAIModelSelection = {
  provider: AIProvider;
  modelId: string;
};

export const normalizeProviderRegion = (
  provider: AIProvider,
  region: DataRegion | undefined,
): DataRegion => {
  if (supportsRegion(provider) && region) {
    return region;
  }

  return "global";
};

const normalizeOrgAIProviderConfig = (
  config: OrgAIProviderConfig,
): OrgAIProviderConfig => {
  switch (config.provider) {
    case "azure_foundry":
    case "huggingface":
      return config;
    case "google":
    case "openrouter":
    case "openai":
    case "anthropic":
    case "bedrock":
    case "mistral":
    case "openai_compatible":
      return {
        ...config,
        region: normalizeProviderRegion(config.provider, config.region),
      };
    default:
      return panic("Unsupported AI provider configuration");
  }
};

const isBYOKProviderId = (provider: AIProvider): provider is BYOKProvider =>
  provider in BYOK_MODEL_OPTIONS;

/**
 * Auto-heal a per-role model selection so it resolves to a model that
 * actually works on the SAME provider. A catalog bump can drop a model
 * id that an org previously pinned; the stored config still decrypts
 * (the id is any non-empty string), but generation would 400 (PDF
 * role) or forward a retired id to the provider (other roles). When
 * the pinned model is no longer offered, fall back to the provider's
 * per-role default.
 *
 * Left unchanged when: the model is still offered; the provider is not
 * a BYOK provider (nothing to heal to on the same provider); or the
 * provider has no valid model for the role at all (mistral + pdf,
 * which has no document-capable model). Those residual cases are
 * surfaced by generation-time validation rather than silently rerouted
 * to a different provider.
 */
const healOverrideModel = (
  role: ModelOverrideGroup,
  selection: OrgAIModelSelection,
): OrgAIModelSelection => {
  if (!isBYOKProviderId(selection.provider)) {
    return selection;
  }
  const working = resolveWorkingBYOKModelForTask({
    provider: selection.provider,
    modelId: selection.modelId,
    task: MODEL_OVERRIDE_GROUP_TASK[role],
  });
  if (!working || working === selection.modelId) {
    return selection;
  }
  return { provider: selection.provider, modelId: working };
};

const healOverrideModels = (
  overrideModels: OrgAIConfig["overrideModels"],
): OrgAIConfig["overrideModels"] => {
  if (overrideModels === null) {
    return null;
  }
  return {
    ...(overrideModels.fast === undefined
      ? {}
      : { fast: healOverrideModel("fast", overrideModels.fast) }),
    ...(overrideModels.chat === undefined
      ? {}
      : { chat: healOverrideModel("chat", overrideModels.chat) }),
    ...(overrideModels.reasoning === undefined
      ? {}
      : {
          reasoning: healOverrideModel("reasoning", overrideModels.reasoning),
        }),
    ...(overrideModels.pdf === undefined
      ? {}
      : { pdf: healOverrideModel("pdf", overrideModels.pdf) }),
  };
};

/** Task defaults stay distinct from persisted override groups. */
export const resolveOrgAIModelForTask = (
  config: OrgAIConfig,
  task: ModelTask,
): OrgAIModelSelection | null => {
  const override = config.overrideModels?.[MODEL_TASK_OVERRIDE_GROUP[task]];
  if (override !== undefined) {
    return override;
  }
  const candidate = resolveDefaultModel({
    task,
    orgProviders: config.providers.map(({ provider }) => provider),
  });
  return candidate === null
    ? null
    : { provider: candidate.provider, modelId: candidate.modelId };
};

export const normalizeOrgAIConfig = (config: OrgAIConfig): OrgAIConfig => ({
  providers: config.providers.map(normalizeOrgAIProviderConfig),
  overrideModels: healOverrideModels(config.overrideModels),
  decision: config.decision,
});
