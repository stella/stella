import type { AIProvider, ModelRole } from "@stll/ai-catalog";

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
const TEMPERATURE_PER_ROLE = {
  fast: 0,
  chat: 0,
  reasoning: 0,
  pdf: 0,
} as const satisfies Record<ModelRole, number>;

export const getTemperatureForRole = (role: ModelRole): number =>
  TEMPERATURE_PER_ROLE[role];

/**
 * Whether stella may annotate this AI request with prompt-cache
 * markers. `reason: "org-disabled"` means the org turned the
 * setting off; future variants (e.g. ZDR) compose into the
 * disabled case.
 *
 * When `enabled`, `scopeKey` carries an optional stable string
 * used as the OpenAI `promptCacheKey` (cache-shard routing) and
 * surfaces in telemetry. `null` means no routing key; opportunistic
 * caching only.
 */
export type CachingDecision =
  | { enabled: false; reason: "org-disabled" }
  | { enabled: true; ttl: "5m"; scopeKey: string | null };

const TTL_BY_ROLE = {
  fast: "5m",
  chat: "5m",
  reasoning: "5m",
  pdf: "5m",
} as const satisfies Record<ModelRole, "5m">;

export const resolveCaching = ({
  promptCachingEnabled,
  role,
  scopeKey,
}: {
  promptCachingEnabled: boolean;
  role: ModelRole;
  scopeKey: string | null;
}): CachingDecision => {
  if (!promptCachingEnabled) {
    return { enabled: false, reason: "org-disabled" };
  }
  return { enabled: true, ttl: TTL_BY_ROLE[role], scopeKey };
};

export type OrgAIConfig = {
  providers: OrgAIProviderConfig[];
  /**
   * Per-role model selection. Every role must resolve to a
   * configured provider. Additional configured providers may
   * be stored for later assignment.
   */
  overrideModels: Record<ModelRole, OrgAIModelSelection>;
};

export type StandardOrgAIProviderConfig = {
  provider: Exclude<AIProvider, "azure_foundry" | "huggingface">;
  /** Decrypted API key. */
  apiKey: string;
  /**
   * Data sovereignty region. When set, AI calls are
   * routed to region-specific endpoints (e.g. Vertex AI
   * europe-west4 for EU).
   */
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

export const normalizeOrgAIProviderConfig = (
  config: OrgAIProviderConfig,
): OrgAIProviderConfig => {
  switch (config.provider) {
    case "azure_foundry":
    case "huggingface":
      return config;
    default:
      return {
        ...config,
        region: normalizeProviderRegion(config.provider, config.region),
      };
  }
};

export const normalizeOrgAIConfig = (config: OrgAIConfig): OrgAIConfig => ({
  providers: config.providers.map(normalizeOrgAIProviderConfig),
  overrideModels: config.overrideModels,
});
