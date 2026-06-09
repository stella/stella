/**
 * Centralized AI model and provider registry.
 *
 * Call sites use `getModelForRole()` with a logical role;
 * provider and model ID are resolved from env config.
 *
 * Provider selection (AI_PROVIDER env var):
 * - "google": Google AI (GOOGLE_GENERATIVE_AI_API_KEY)
 * - "openrouter": OpenRouter (OPENROUTER_API_KEY)
 * - "openai": OpenAI (OPENAI_API_KEY)
 * - "azure_foundry": Azure AI Foundry / Azure OpenAI
 *   (AZURE_API_KEY + AZURE_RESOURCE_NAME or AZURE_BASE_URL)
 * - "anthropic": Anthropic (ANTHROPIC_API_KEY)
 * - "mistral": Mistral AI (MISTRAL_API_KEY)
 * - "openai_compatible": Any OpenAI-compatible endpoint
 *   (OPENAI_API_KEY + AI_PROVIDER_BASE_URL)
 * - "huggingface": HuggingFace Inference Endpoint (OpenAI-compatible)
 *   (HUGGINGFACE_API_KEY + HUGGINGFACE_BASE_URL)
 *
 * When AI_PROVIDER is not set, auto-detects from available
 * API keys: OPENROUTER → Google → OpenAI → Azure → Anthropic →
 * Mistral → HuggingFace.
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import type { GoogleLanguageModelOptions } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createMistral, mistral } from "@ai-sdk/mistral";
import { createOpenAI, openai } from "@ai-sdk/openai";
import type { OpenAILanguageModelChatOptions } from "@ai-sdk/openai";
import { APICallError } from "@ai-sdk/provider";
import type {
  JSONObject,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import { panic, Result } from "better-result";

import {
  AI_PROVIDERS,
  ANTHROPIC_ADAPTIVE_THINKING_MODELS,
  ANTHROPIC_FIXED_SAMPLING_MODELS,
  BYOK_MODEL_OPTIONS,
  DEFAULT_MODELS,
} from "@stll/ai-catalog";
import type { AIProvider, BYOKProvider, ModelRole } from "@stll/ai-catalog";

import type { UsageServiceTier } from "@/api/db/schema";
import { env } from "@/api/env";
import {
  AZURE_FOUNDRY_DEFAULT_API_VERSION,
  normalizeAzureFoundryBaseURL,
} from "@/api/lib/azure-foundry";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// -- Catalog ----------------------------------------------------

// Roles, providers, per-role defaults, BYOK options, and the
// adaptive-thinking set are the single source of truth in
// @stll/ai-catalog, shared with the BYOK settings UI in apps/web so the
// picker can never offer a model the API rejects. Re-exported here so
// existing `@/api/lib/ai-models` consumers keep their imports.
export { AI_PROVIDERS, BYOK_MODEL_OPTIONS, DEFAULT_MODELS };
export { MODEL_ROLES } from "@stll/ai-catalog";
export type { AIProvider, BYOKProvider, ModelRole };

const AI_PROVIDER_VALUES = new Set<string>(AI_PROVIDERS);

const isAIProvider = (value: string): value is AIProvider =>
  AI_PROVIDER_VALUES.has(value);

const CUSTOM_BYOK_MODEL_PROVIDERS = new Set<BYOKProvider>([
  "azure_foundry",
  "huggingface",
]);

export const isBYOKProvider = (
  provider: AIProvider,
): provider is BYOKProvider => provider in BYOK_MODEL_OPTIONS;

export const isAllowedBYOKModel = (
  provider: AIProvider,
  modelId: string,
): boolean => {
  if (!isBYOKProvider(provider)) {
    return false;
  }
  if (CUSTOM_BYOK_MODEL_PROVIDERS.has(provider)) {
    return modelId.trim().length > 0;
  }
  const allowed: readonly string[] = BYOK_MODEL_OPTIONS[provider];
  return allowed.includes(modelId);
};

export type DataRegion = "eu" | "global" | "ch";
export type AIRequestServiceTier = UsageServiceTier;
export const STELLA_PROVIDER_METADATA_KEY = "stella";
export const SERVICE_TIER_PROVIDER_METADATA_KEY = "effectiveServiceTier";
export const FALLBACK_FROM_SERVICE_TIER_PROVIDER_METADATA_KEY =
  "fallbackFromServiceTier";

/**
 * Providers that support regional endpoint routing.
 * Currently only Google via Vertex AI Express Mode.
 * OpenAI (Azure), Anthropic (Bedrock) require separate
 * integration work and are not yet supported.
 */
export const REGIONAL_PROVIDERS = new Set<AIProvider>(["google"]);

/**
 * Check whether a provider supports regional routing.
 * Used at config save time to reject unsupported
 * provider + region combinations.
 */
export const supportsRegion = (provider: AIProvider): boolean =>
  REGIONAL_PROVIDERS.has(provider);

/**
 * Sampling temperature per logical role.
 *
 * Legal work prioritizes determinism over creativity. Every role
 * is pinned to 0 so the same input yields the same output —
 * critical for tool-call paths where stray sampling becomes
 * malformed structured output (HTML inside a plain-text edit
 * payload, fabricated field names, etc.).
 *
 * Provider defaults (1.0 for OpenAI/Anthropic) are too high
 * for our use cases.
 */
const TEMPERATURE_PER_ROLE = {
  fast: 0,
  chat: 0,
  reasoning: 0,
  pdf: 0,
} as const satisfies Record<ModelRole, number>;

export const getTemperatureForRole = (role: ModelRole): number =>
  TEMPERATURE_PER_ROLE[role];

// -- Prompt caching ---------------------------------------------

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

// -- Provider resolution ----------------------------------------

type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]["model"];
type ModelFactory = (modelId: string) => WrappableLanguageModel;

type ModelFactoryOptions = {
  provider: AIProvider;
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  region?: DataRegion | undefined;
  apiVersion?: string | undefined;
};

const resolveProvider = (): AIProvider => {
  if (env.AI_PROVIDER) {
    return env.AI_PROVIDER;
  }
  if (env.OPENROUTER_API_KEY) {
    return "openrouter";
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return "google";
  }
  if (env.OPENAI_API_KEY) {
    return "openai";
  }
  if (env.AZURE_API_KEY && (env.AZURE_RESOURCE_NAME || env.AZURE_BASE_URL)) {
    return "azure_foundry";
  }
  if (env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }
  if (env.MISTRAL_API_KEY) {
    return "mistral";
  }
  if (env.HUGGINGFACE_API_KEY && env.HUGGINGFACE_BASE_URL) {
    return "huggingface";
  }

  return panic(
    "No AI provider configured. Set AI_PROVIDER or " +
      "provide at least one API key: " +
      "GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, " +
      "OPENAI_API_KEY, AZURE_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, " +
      "or HUGGINGFACE_API_KEY (with HUGGINGFACE_BASE_URL).",
  );
};

const hasInstanceProviderCredentials = (provider: AIProvider): boolean => {
  if (env.REQUIRE_PERSONAL_AI_KEY) {
    return false;
  }
  if (env.USE_MOCK_AI) {
    return true;
  }

  switch (provider) {
    case "openrouter":
      return !!env.OPENROUTER_API_KEY;
    case "google":
      return !!(
        env.GOOGLE_GENERATIVE_AI_API_KEY ||
        env.GOOGLE_AI_API_KEY_EU ||
        env.GOOGLE_AI_API_KEY_CH
      );
    case "openai":
      return !!env.OPENAI_API_KEY;
    case "azure_foundry":
      return !!(
        env.AZURE_API_KEY &&
        (env.AZURE_RESOURCE_NAME || env.AZURE_BASE_URL)
      );
    case "anthropic":
      return !!env.ANTHROPIC_API_KEY;
    case "mistral":
      return !!env.MISTRAL_API_KEY;
    case "openai_compatible":
      return !!(env.OPENAI_API_KEY && env.AI_PROVIDER_BASE_URL);
    case "huggingface":
      return !!(env.HUGGINGFACE_API_KEY && env.HUGGINGFACE_BASE_URL);
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

/**
 * Whether the instance can serve AI to an org that has not set
 * BYOK. False when REQUIRE_PERSONAL_AI_KEY forces BYOK or when
 * no provider has the credentials it needs to run.
 *
 * AI_PROVIDER alone is not enough: an explicit provider must be
 * paired with the matching key (e.g. AI_PROVIDER=openai requires
 * OPENAI_API_KEY) or the model factory will fail at runtime.
 */
export const hasInstanceProvider = (): boolean => {
  if (env.REQUIRE_PERSONAL_AI_KEY) {
    return false;
  }
  if (!env.AI_PROVIDER) {
    return AI_PROVIDERS.some(hasInstanceProviderCredentials);
  }
  return hasInstanceProviderCredentials(env.AI_PROVIDER);
};

/**
 * Backend gate matching the frontend RequireAIKey component.
 * Yield from a Result.gen handler to short-circuit AI requests
 * with 403 when the org has no BYOK and the instance has no
 * provisioned (or BYOK-only) provider.
 */
export const requireAIAvailable = (
  orgConfig: OrgAIConfig | null,
): Result<void, HandlerError> => {
  if (orgConfig || hasInstanceProvider()) {
    return Result.ok(undefined);
  }
  return Result.err(
    new HandlerError({
      status: 403,
      message:
        "AI is not available. Configure an AI key in organization settings.",
    }),
  );
};

/**
 * GCP locations for data sovereignty regions.
 * Vertex AI Express Mode routes through these.
 */
const REGION_LOCATIONS = {
  eu: "europe-west4",
  ch: "europe-west6",
} as const satisfies Record<Exclude<DataRegion, "global">, string>;

/**
 * Create a regional Vertex AI factory.
 * Uses Express Mode (API key) when available, otherwise
 * falls back to a regional Google AI Studio key.
 */
const createRegionalGoogleFactory = (
  region: Exclude<DataRegion, "global">,
  apiKey?: string,
): ModelFactory | null => {
  // Vertex AI Express Mode: API key + location.
  const vertexKey =
    apiKey ??
    (region === "eu" ? env.GOOGLE_AI_API_KEY_EU : env.GOOGLE_AI_API_KEY_CH);

  if (!vertexKey) {
    return null;
  }

  const client = createVertex({
    apiKey: vertexKey,
    location: REGION_LOCATIONS[region],
  });
  return (id) => client(id);
};

const resolveAzureApiVersion = (apiVersion: string | undefined): string =>
  apiVersion?.trim() ||
  env.AZURE_API_VERSION ||
  AZURE_FOUNDRY_DEFAULT_API_VERSION;

const createModelFactory = ({
  provider,
  apiKey,
  baseURL,
  region,
  apiVersion,
}: ModelFactoryOptions): ModelFactory => {
  switch (provider) {
    case "google": {
      // Regional routing: use Vertex AI with location.
      if (region && region !== "global") {
        const regional = createRegionalGoogleFactory(region, apiKey);
        if (regional) {
          return regional;
        }
        // BYOK path: the org explicitly requested a region
        // with their own key, so failing is correct.
        if (apiKey) {
          panic(
            `Regional routing requested (${region}) but ` +
              "Vertex AI Express Mode key is invalid.",
          );
        }
        // Instance path: regional key not configured by
        // the deployment. Fall through to the default
        // (non-regional) factory rather than crashing.
      }
      // BYOK with explicit key (non-regional).
      if (apiKey) {
        const client = createGoogleGenerativeAI({
          apiKey,
        });
        return (id) => client(id);
      }
      return (id) => google(id);
    }
    case "openrouter": {
      const key =
        apiKey ??
        env.OPENROUTER_API_KEY ??
        panic("OPENROUTER_API_KEY required for openrouter");
      const client = createOpenRouter({ apiKey: key });
      return (id) => client.chat(id);
    }
    case "openai": {
      if (apiKey) {
        const client = createOpenAI({ apiKey });
        return (id) => client(id);
      }
      return (id) => openai(id);
    }
    case "azure_foundry": {
      const key =
        apiKey ??
        env.AZURE_API_KEY ??
        panic("AZURE_API_KEY required for azure_foundry");
      const resourceName = baseURL ? undefined : env.AZURE_RESOURCE_NAME;
      const rawURL =
        baseURL ??
        (env.AZURE_BASE_URL
          ? resolveAzureFoundryEnvBaseURL(env.AZURE_BASE_URL)
          : undefined);
      const url =
        rawURL ??
        (resourceName
          ? undefined
          : panic(
              "AZURE_RESOURCE_NAME or AZURE_BASE_URL required for azure_foundry",
            ));
      const resolvedApiVersion = resolveAzureApiVersion(apiVersion);
      const client = createAzure(
        url
          ? {
              apiKey: key,
              baseURL: url,
              apiVersion: resolvedApiVersion,
            }
          : {
              apiKey: key,
              resourceName:
                resourceName ??
                panic(
                  "AZURE_RESOURCE_NAME or AZURE_BASE_URL required for azure_foundry",
                ),
              apiVersion: resolvedApiVersion,
            },
      );
      return (id) => client(id);
    }
    case "anthropic": {
      if (apiKey) {
        const client = createAnthropic({ apiKey });
        return (id) => client(id);
      }
      return (id) => anthropic(id);
    }
    case "mistral": {
      if (apiKey) {
        const client = createMistral({ apiKey });
        return (id) => client(id);
      }
      return (id) => mistral(id);
    }
    case "openai_compatible": {
      const key =
        apiKey ??
        env.OPENAI_API_KEY ??
        panic("OPENAI_API_KEY required for openai_compatible");
      const url =
        baseURL ??
        env.AI_PROVIDER_BASE_URL ??
        panic("AI_PROVIDER_BASE_URL required for openai_compatible");
      const client = createOpenAI({
        baseURL: url,
        apiKey: key,
        name: "huggingface",
      });
      return (id) => client(id);
    }
    case "huggingface": {
      const key =
        apiKey ??
        env.HUGGINGFACE_API_KEY ??
        panic("HUGGINGFACE_API_KEY required for huggingface");
      const url =
        baseURL ??
        env.HUGGINGFACE_BASE_URL ??
        panic("HUGGINGFACE_BASE_URL required for huggingface");
      const client = createOpenAI({
        baseURL: url,
        apiKey: key,
      });
      return (id) => client(id);
    }
    default:
      // Exhaustive check: if a new provider is added to
      // AIProvider but not handled above, this errors at
      // compile time.
      return panic(provider);
  }
};

const resolveAzureFoundryEnvBaseURL = (rawURL: string): string => {
  const normalized = normalizeAzureFoundryBaseURL(rawURL);
  if (!normalized.ok) {
    return panic(`Invalid AZURE_BASE_URL: ${normalized.error}`);
  }
  return normalized.baseURL;
};

// -- BYOK org config --------------------------------------------

/**
 * Organization-level AI configuration (BYOK).
 *
 * Loaded once at connection/session establishment and
 * threaded through to getModelForRole. Never fetched
 * per AI call.
 */
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
  /** Normalized @ai-sdk/azure baseURL, without the trailing `/v1`. */
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

export type ResolvedModelInfo = {
  keySource: "byok" | "instance";
  provider: AIProvider;
  modelId: string;
  region?: DataRegion | undefined;
};

type ModelOverride = {
  modelId: string;
  provider?: AIProvider | undefined;
};

const decodeModelOverride = (value: string): ModelOverride => {
  const [providerRaw, ...modelParts] = value.split("::");
  const modelId = modelParts.join("::");

  if (providerRaw && modelId && isAIProvider(providerRaw)) {
    return { provider: providerRaw, modelId };
  }

  return { modelId: value };
};

// -- BYOK factory cache -----------------------------------------

/**
 * LRU cache for BYOK model factories. Keyed by a stable
 * hash of (provider + apiKey + endpoint/region) so we don't
 * recreate HTTP clients on every call within the same
 * connection. Uses a truncated SHA-256 digest to avoid
 * holding full secrets as map keys.
 */
const BYOK_CACHE_MAX = 64;
const byokCache = new Map<string, ModelFactory>();

const byokCacheKey = (config: OrgAIProviderConfig): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(config.provider);
  hasher.update(config.apiKey);
  switch (config.provider) {
    case "azure_foundry":
      hasher.update(config.baseURL);
      hasher.update(resolveAzureApiVersion(config.apiVersion));
      break;
    case "huggingface":
      hasher.update(config.baseURL);
      break;
    default:
      hasher.update(config.region ?? "global");
      break;
  }
  const hash = hasher.digest("hex").slice(0, 16);
  return `${config.provider}:${hash}`;
};

const getCachedFactory = (config: OrgAIProviderConfig): ModelFactory => {
  const key = byokCacheKey(config);
  const cached = byokCache.get(key);
  if (cached) {
    return cached;
  }
  // Evict oldest entry if at capacity.
  if (byokCache.size >= BYOK_CACHE_MAX) {
    const oldest = byokCache.keys().next().value;
    if (oldest !== undefined) {
      byokCache.delete(oldest);
    }
  }
  const factory = createModelFactory({
    provider: config.provider,
    apiKey: config.apiKey,
    ...factoryExtras(config),
  });
  byokCache.set(key, factory);
  return factory;
};

type FactoryExtras = Pick<
  ModelFactoryOptions,
  "baseURL" | "apiVersion" | "region"
>;

const factoryExtras = (config: OrgAIProviderConfig): FactoryExtras => {
  switch (config.provider) {
    case "azure_foundry":
      return { baseURL: config.baseURL, apiVersion: config.apiVersion };
    case "huggingface":
      return { baseURL: config.baseURL };
    default:
      return { region: config.region };
  }
};

// -- Instance-level singleton (lazy) ----------------------------

let _activeProvider: AIProvider | undefined;

/** Resolved provider (e.g. "google", "openrouter"). */
const getActiveProvider = (): AIProvider => {
  _activeProvider ??= resolveProvider();
  return _activeProvider;
};

let _instanceFactory: ModelFactory | undefined;

const getInstanceFactory = (): ModelFactory => {
  _instanceFactory ??= createModelFactory({ provider: getActiveProvider() });
  return _instanceFactory;
};

const MODEL_OVERRIDES = {
  fast: env.AI_MODEL_FAST,
  chat: env.AI_MODEL_CHAT,
  reasoning: env.AI_MODEL_REASONING,
  pdf: env.AI_MODEL_PDF,
} satisfies Record<ModelRole, string | undefined>;

const isAIDevToolsEnabled = (): boolean => env.AI_DEVTOOLS_ENABLED;

type SingleMiddleware = LanguageModelMiddleware;

const PROVIDER_CACHE_KEY_MAX = 64;

const hashScopeKey = (raw: string): string =>
  new Bun.CryptoHasher("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, PROVIDER_CACHE_KEY_MAX);

type CallOptions = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"];
type ProviderOptionsMap = NonNullable<CallOptions["providerOptions"]>;
type ProviderOptionsValue = ProviderOptionsMap[string];

const omitKey = (
  entry: ProviderOptionsValue,
  key: string,
): ProviderOptionsValue => {
  if (!(key in entry)) {
    return entry;
  }
  const { [key]: _omitted, ...rest } = entry;
  return rest;
};

const stripCacheMarkersFromProviderOptions = (
  providerOptions: ProviderOptionsMap | undefined,
): ProviderOptionsMap | undefined => {
  if (providerOptions === undefined) {
    return providerOptions;
  }
  const next: ProviderOptionsMap = { ...providerOptions };
  const anthropicEntry = next["anthropic"];
  if (anthropicEntry !== undefined) {
    next["anthropic"] = omitKey(anthropicEntry, "cacheControl");
  }
  const openaiEntry = next["openai"];
  if (openaiEntry !== undefined) {
    next["openai"] = omitKey(openaiEntry, "promptCacheKey");
  }
  const googleEntry = next["google"];
  if (googleEntry !== undefined) {
    next["google"] = omitKey(googleEntry, "cachedContent");
  }
  return next;
};

type PromptMessage = CallOptions["prompt"][number];

const stripCacheMarkersFromPrompt = (
  prompt: CallOptions["prompt"],
): CallOptions["prompt"] =>
  prompt.map((message): PromptMessage => {
    const cleanedProviderOptions = stripCacheMarkersFromProviderOptions(
      message.providerOptions,
    );
    const providerOptionsPatch =
      cleanedProviderOptions !== undefined
        ? { providerOptions: cleanedProviderOptions }
        : {};
    if (message.role === "system" || typeof message.content === "string") {
      return { ...message, ...providerOptionsPatch };
    }
    if (message.role === "user") {
      return {
        ...message,
        ...providerOptionsPatch,
        content: message.content.map((part) => {
          const cleaned = stripCacheMarkersFromProviderOptions(
            part.providerOptions,
          );
          return cleaned === undefined
            ? part
            : { ...part, providerOptions: cleaned };
        }),
      };
    }
    if (message.role === "assistant") {
      return {
        ...message,
        ...providerOptionsPatch,
        content: message.content.map((part) => {
          const cleaned = stripCacheMarkersFromProviderOptions(
            part.providerOptions,
          );
          return cleaned === undefined
            ? part
            : { ...part, providerOptions: cleaned };
        }),
      };
    }
    return {
      ...message,
      ...providerOptionsPatch,
      content: message.content.map((part) => {
        const cleaned = stripCacheMarkersFromProviderOptions(
          part.providerOptions,
        );
        return cleaned === undefined
          ? part
          : { ...part, providerOptions: cleaned };
      }),
    };
  });

const markAnthropicSystemEphemeral = (
  prompt: CallOptions["prompt"],
): CallOptions["prompt"] =>
  prompt.map((message) => {
    if (message.role !== "system") {
      return message;
    }
    const existingMessageOptions = message.providerOptions ?? {};
    const existingAnthropic = existingMessageOptions["anthropic"] ?? {};
    if (existingAnthropic["cacheControl"] !== undefined) {
      return message;
    }
    return {
      ...message,
      providerOptions: {
        ...existingMessageOptions,
        anthropic: {
          ...existingAnthropic,
          cacheControl: { type: "ephemeral" },
        },
      },
    };
  });

const computeCachingParams = (
  params: CallOptions,
  provider: AIProvider,
  decision: CachingDecision,
): CallOptions => {
  // OFF: strip every cache marker the caller may have set so the
  // wire payload carries no caching state regardless of provider.
  if (!decision.enabled) {
    const strippedPrompt = stripCacheMarkersFromPrompt(params.prompt);
    const strippedProviderOptions = stripCacheMarkersFromProviderOptions(
      params.providerOptions,
    );
    return {
      ...params,
      prompt: strippedPrompt,
      ...(strippedProviderOptions !== undefined
        ? { providerOptions: strippedProviderOptions }
        : {}),
    };
  }

  // ON: preserve caller-placed breakpoints (e.g. `markCacheBreakpoint`
  // on the document content in workflow extraction) and only add
  // baseline markers — Anthropic system cacheControl if absent,
  // OpenAI promptCacheKey derived from scopeKey.
  let nextPrompt = params.prompt;
  let nextProviderOptions = params.providerOptions;

  if (provider === "anthropic") {
    nextPrompt = markAnthropicSystemEphemeral(params.prompt);
  }

  if (
    (provider === "openai" || provider === "azure_foundry") &&
    decision.scopeKey !== null
  ) {
    const existingOpenai = nextProviderOptions?.["openai"] ?? {};
    nextProviderOptions = {
      ...nextProviderOptions,
      openai: {
        ...existingOpenai,
        promptCacheKey: hashScopeKey(decision.scopeKey),
      },
    };
  }

  return {
    ...params,
    prompt: nextPrompt,
    ...(nextProviderOptions !== undefined
      ? { providerOptions: nextProviderOptions }
      : {}),
  };
};

const cachingMiddleware = (
  provider: AIProvider,
  decision: CachingDecision,
): SingleMiddleware => ({
  specificationVersion: "v3",
  transformParams: async ({ params }) =>
    await Promise.resolve(computeCachingParams(params, provider, decision)),
});

// -- Provider service tier routing ------------------------------

export type ServiceTierProviderTarget =
  | "google_gemini_api"
  | "google_vertex"
  | "openai"
  | "none";

const GOOGLE_GEMINI_FLEX_TIER = "flex" satisfies NonNullable<
  GoogleLanguageModelOptions["serviceTier"]
>;
const GOOGLE_GEMINI_STANDARD_TIER = "standard" satisfies NonNullable<
  GoogleLanguageModelOptions["serviceTier"]
>;
const GOOGLE_VERTEX_FLEX_SHARED_REQUEST_TYPE = "flex" satisfies NonNullable<
  GoogleLanguageModelOptions["sharedRequestType"]
>;
const GOOGLE_VERTEX_SHARED_REQUEST_TYPE = "shared" satisfies NonNullable<
  GoogleLanguageModelOptions["requestType"]
>;
const OPENAI_FLEX_TIER = "flex" satisfies NonNullable<
  OpenAILanguageModelChatOptions["serviceTier"]
>;
const OPENAI_STANDARD_TIER = "default" satisfies NonNullable<
  OpenAILanguageModelChatOptions["serviceTier"]
>;

type GoogleGeminiServiceTierOptions = Pick<
  GoogleLanguageModelOptions,
  "serviceTier"
>;
type GoogleVertexServiceTierOptions = Pick<
  GoogleLanguageModelOptions,
  "requestType" | "sharedRequestType"
>;
type OpenAIServiceTierOptions = Pick<
  OpenAILanguageModelChatOptions,
  "serviceTier"
>;

const providerTargetForConfig = (
  config: OrgAIProviderConfig,
): ServiceTierProviderTarget => {
  if (
    config.provider === "azure_foundry" ||
    config.provider === "huggingface"
  ) {
    return providerTargetForProvider({ provider: config.provider });
  }

  return providerTargetForProvider({
    provider: config.provider,
    region: config.region,
  });
};

const providerTargetForProvider = ({
  provider,
  region,
}: {
  provider: AIProvider;
  region?: DataRegion | undefined;
}): ServiceTierProviderTarget => {
  if (provider === "google") {
    return region && region !== "global"
      ? "google_vertex"
      : "google_gemini_api";
  }
  if (provider === "openai") {
    return "openai";
  }
  return "none";
};

const providerTargetForInstanceProvider = (
  provider: AIProvider,
): ServiceTierProviderTarget => providerTargetForProvider({ provider });

const isDeferredServiceTier = (serviceTier: AIRequestServiceTier): boolean =>
  serviceTier === "flex" || serviceTier === "batch";

export const resolveEffectiveServiceTierForProvider = ({
  provider,
  region,
  serviceTier,
}: {
  provider: AIProvider;
  region?: DataRegion | undefined;
  serviceTier: AIRequestServiceTier;
}): AIRequestServiceTier => {
  if (!isDeferredServiceTier(serviceTier)) {
    return serviceTier;
  }

  const target = providerTargetForProvider({ provider, region });
  return target === "none" ? "standard" : serviceTier;
};

const mergeProviderOptionPatch = (
  providerOptions: ProviderOptionsMap | undefined,
  providerKey: string,
  patch: ProviderOptionsValue,
): ProviderOptionsMap => {
  const existing = providerOptions?.[providerKey] ?? {};
  return {
    ...providerOptions,
    [providerKey]: {
      ...existing,
      ...patch,
    },
  };
};

export const resolveServiceTierProviderOptions = ({
  target,
  serviceTier,
}: {
  target: ServiceTierProviderTarget;
  serviceTier: AIRequestServiceTier;
}): ProviderOptionsMap | undefined => {
  if (target === "google_gemini_api") {
    const googleOptions = {
      serviceTier: isDeferredServiceTier(serviceTier)
        ? GOOGLE_GEMINI_FLEX_TIER
        : GOOGLE_GEMINI_STANDARD_TIER,
    } satisfies GoogleGeminiServiceTierOptions;

    return {
      google: googleOptions,
    };
  }

  if (target === "google_vertex") {
    if (!isDeferredServiceTier(serviceTier)) {
      return undefined;
    }
    const vertexOptions = {
      sharedRequestType: GOOGLE_VERTEX_FLEX_SHARED_REQUEST_TYPE,
      requestType: GOOGLE_VERTEX_SHARED_REQUEST_TYPE,
    } satisfies GoogleVertexServiceTierOptions;

    return {
      vertex: vertexOptions,
    };
  }

  if (target === "openai") {
    const openaiOptions = {
      serviceTier: isDeferredServiceTier(serviceTier)
        ? OPENAI_FLEX_TIER
        : OPENAI_STANDARD_TIER,
    } satisfies OpenAIServiceTierOptions;

    return {
      openai: openaiOptions,
    };
  }

  return undefined;
};

const computeServiceTierParams = (
  params: CallOptions,
  target: ServiceTierProviderTarget,
  serviceTier: AIRequestServiceTier,
): CallOptions => {
  const providerOptionsPatch = resolveServiceTierProviderOptions({
    target,
    serviceTier,
  });
  if (providerOptionsPatch === undefined) {
    return params;
  }

  let nextProviderOptions: ProviderOptionsMap = params.providerOptions ?? {};
  for (const [providerKey, patch] of Object.entries(providerOptionsPatch)) {
    nextProviderOptions = mergeProviderOptionPatch(
      nextProviderOptions,
      providerKey,
      patch,
    );
  }

  return {
    ...params,
    providerOptions: nextProviderOptions,
  };
};

const computeStandardFallbackServiceTierParams = (
  params: CallOptions,
  target: ServiceTierProviderTarget,
): CallOptions => {
  if (target === "google_vertex") {
    const vertexOptions = params.providerOptions?.["vertex"];
    if (vertexOptions === undefined) {
      return params;
    }

    const {
      sharedRequestType: _sharedRequestType,
      requestType: _requestType,
      ...standardVertexOptions
    } = vertexOptions;
    return {
      ...params,
      providerOptions: {
        ...params.providerOptions,
        vertex: standardVertexOptions,
      },
    };
  }

  return computeServiceTierParams(params, target, "standard");
};

const isServiceTierFallbackError = (error: unknown): boolean =>
  APICallError.isInstance(error) &&
  error.isRetryable &&
  error.statusCode !== undefined;

const shouldRetryWithStandardServiceTier = ({
  error,
  serviceTier,
  target,
}: {
  error: unknown;
  serviceTier: AIRequestServiceTier;
  target: ServiceTierProviderTarget;
}): boolean =>
  target !== "none" &&
  isDeferredServiceTier(serviceTier) &&
  isServiceTierFallbackError(error);

const buildServiceTierFallbackMetadata = (
  fallbackFromServiceTier: AIRequestServiceTier,
): SharedV3ProviderMetadata => ({
  [STELLA_PROVIDER_METADATA_KEY]: {
    [SERVICE_TIER_PROVIDER_METADATA_KEY]: "standard",
    [FALLBACK_FROM_SERVICE_TIER_PROVIDER_METADATA_KEY]: fallbackFromServiceTier,
  },
});

const mergeProviderMetadata = (
  providerMetadata: SharedV3ProviderMetadata | undefined,
  patch: SharedV3ProviderMetadata,
): SharedV3ProviderMetadata => {
  const next: SharedV3ProviderMetadata = { ...providerMetadata };

  for (const [providerKey, providerPatch] of Object.entries(patch)) {
    next[providerKey] = {
      ...providerMetadata?.[providerKey],
      ...providerPatch,
    };
  }

  return next;
};

const markServiceTierFallbackGenerateResult = (
  result: LanguageModelV3GenerateResult,
  fallbackFromServiceTier: AIRequestServiceTier,
): LanguageModelV3GenerateResult => ({
  ...result,
  providerMetadata: mergeProviderMetadata(
    result.providerMetadata,
    buildServiceTierFallbackMetadata(fallbackFromServiceTier),
  ),
});

const markServiceTierFallbackStreamResult = (
  result: LanguageModelV3StreamResult,
  fallbackFromServiceTier: AIRequestServiceTier,
): LanguageModelV3StreamResult => ({
  ...result,
  stream: result.stream.pipeThrough(
    new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
      transform: (chunk, controller) => {
        if (chunk.type !== "finish") {
          controller.enqueue(chunk);
          return;
        }

        controller.enqueue({
          ...chunk,
          providerMetadata: mergeProviderMetadata(
            chunk.providerMetadata,
            buildServiceTierFallbackMetadata(fallbackFromServiceTier),
          ),
        });
      },
    }),
  ),
});

export const createServiceTierMiddleware = (
  target: ServiceTierProviderTarget,
  serviceTier: AIRequestServiceTier,
  {
    allowFallbackToStandard = true,
  }: { allowFallbackToStandard?: boolean } = {},
): SingleMiddleware => ({
  specificationVersion: "v3",
  transformParams: async ({ params }) =>
    await Promise.resolve(
      computeServiceTierParams(params, target, serviceTier),
    ),
  wrapGenerate: async ({ doGenerate, model, params }) => {
    try {
      return await doGenerate();
    } catch (error) {
      if (
        !allowFallbackToStandard ||
        !shouldRetryWithStandardServiceTier({ error, serviceTier, target })
      ) {
        throw error;
      }

      return markServiceTierFallbackGenerateResult(
        await model.doGenerate(
          computeStandardFallbackServiceTierParams(params, target),
        ),
        serviceTier,
      );
    }
  },
  wrapStream: async ({ doStream, model, params }) => {
    try {
      return await doStream();
    } catch (error) {
      if (
        !allowFallbackToStandard ||
        !shouldRetryWithStandardServiceTier({ error, serviceTier, target })
      ) {
        throw error;
      }

      return markServiceTierFallbackStreamResult(
        await model.doStream(
          computeStandardFallbackServiceTierParams(params, target),
        ),
        serviceTier,
      );
    }
  },
});

// -- Default settings -------------------------------------------

/**
 * Anthropic recommends an opaque hash for `metadata.user_id`
 * rather than the raw organisation id. Truncated SHA-256 keeps
 * the value stable per org without leaking the safe id verbatim.
 */
const hashOrgId = (orgId: SafeId<"organization">): string =>
  new Bun.CryptoHasher("sha256").update(orgId).digest("hex").slice(0, 16);

/**
 * Sensible Google `safetySettings` baseline for legal-document
 * workloads. The default Gemini thresholds occasionally refuse
 * benign legal content (defamation discussions, criminal-case
 * summaries); raising the threshold avoids surprise refusals
 * while still blocking the worst categories at HIGH.
 */
const GOOGLE_SAFETY_SETTINGS_BASELINE = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
];

type Settings = Parameters<typeof defaultSettingsMiddleware>[0]["settings"];

type DefaultsBuilderParams = {
  role: ModelRole;
  orgId: SafeId<"organization"> | null;
  modelId: string;
};

type DefaultsBuilder = (params: DefaultsBuilderParams) => Settings;

const googleDefaults: DefaultsBuilder = ({ role }) => ({
  temperature: TEMPERATURE_PER_ROLE[role],
  providerOptions: {
    google: {
      thinkingConfig: {
        thinkingLevel: role === "reasoning" ? "high" : "minimal",
        includeThoughts: false,
      },
      safetySettings: GOOGLE_SAFETY_SETTINGS_BASELINE,
    },
  },
});

const buildAnthropicMetadata = (
  orgId: SafeId<"organization"> | null,
): { metadata: { userId: string } } | Record<string, never> =>
  orgId === null ? {} : { metadata: { userId: hashOrgId(orgId) } };

// `temperature?: never` makes it a compile error to set temperature
// here. Anthropic rejects custom temperature when extended thinking
// is enabled on Claude pre-Opus-4.7 (incl. stella's default
// sonnet-4-6 for the reasoning role); the provider's built-in
// default (1) is what the API requires when thinking is on.
type AnthropicReasoningSettings = Omit<Settings, "temperature"> & {
  temperature?: never;
};

const ANTHROPIC_LEGACY_THINKING_BUDGET_TOKENS = 10_000;

const supportsAnthropicAdaptiveThinking = (modelId: string): boolean =>
  ANTHROPIC_ADAPTIVE_THINKING_MODELS.some((supportedModelId) =>
    modelId.includes(supportedModelId),
  );

const rejectsAnthropicSamplingParams = (modelId: string): boolean =>
  ANTHROPIC_FIXED_SAMPLING_MODELS.some((fixedModelId) =>
    modelId.includes(fixedModelId),
  );

const anthropicThinkingForModel = (modelId: string): JSONObject =>
  supportsAnthropicAdaptiveThinking(modelId)
    ? { type: "adaptive" }
    : {
        type: "enabled",
        budgetTokens: ANTHROPIC_LEGACY_THINKING_BUDGET_TOKENS,
      };

const anthropicReasoningDefaults = (
  orgId: SafeId<"organization"> | null,
  modelId: string,
): AnthropicReasoningSettings => {
  // AI SDK source: adaptive thinking is supported on Claude
  // sonnet-4-6, opus-4-6, opus-4-7, opus-4-8; earlier 4.5 models
  // use the budget-based `type: "enabled"` form.
  const anthropicOptions: JSONObject = {
    ...buildAnthropicMetadata(orgId),
    thinking: anthropicThinkingForModel(modelId),
  };
  return { providerOptions: { anthropic: anthropicOptions } };
};

const anthropicNonReasoningDefaults = (
  role: Exclude<ModelRole, "reasoning">,
  orgId: SafeId<"organization"> | null,
): Settings => {
  const settings: Settings = { temperature: TEMPERATURE_PER_ROLE[role] };
  if (orgId !== null) {
    const anthropicOptions: JSONObject = buildAnthropicMetadata(orgId);
    settings.providerOptions = { anthropic: anthropicOptions };
  }
  return settings;
};

const anthropicDefaults: DefaultsBuilder = ({ role, orgId, modelId }) =>
  role === "reasoning"
    ? anthropicReasoningDefaults(orgId, modelId)
    : anthropicNonReasoningDefaults(role, orgId);

const openaiDefaults: DefaultsBuilder = ({ role }) => {
  const settings: Settings = { temperature: TEMPERATURE_PER_ROLE[role] };
  if (role === "reasoning") {
    settings.providerOptions = { openai: { reasoningEffort: "medium" } };
  }
  return settings;
};

// Azure's AI SDK provider registers under `azure.*` (not `openai.*`),
// and the property name is `reasoningEffort` (camelCase, not snake).
const azureFoundryDefaults: DefaultsBuilder = ({ role }) => {
  const settings: Settings = { temperature: TEMPERATURE_PER_ROLE[role] };
  if (role === "reasoning") {
    settings.providerOptions = { azure: { reasoningEffort: "medium" } };
  }
  return settings;
};

const bareTemperatureDefaults: DefaultsBuilder = ({ role }) => ({
  temperature: TEMPERATURE_PER_ROLE[role],
});

// `satisfies Record<AIProvider, ...>` makes adding a new provider to
// AI_PROVIDERS a compile error here, so no provider can silently
// fall through to a generic default that ignores its own knobs.
const DEFAULTS_BUILDERS = {
  google: googleDefaults,
  anthropic: anthropicDefaults,
  openai: openaiDefaults,
  azure_foundry: azureFoundryDefaults,
  openrouter: bareTemperatureDefaults,
  mistral: bareTemperatureDefaults,
  openai_compatible: bareTemperatureDefaults,
  huggingface: bareTemperatureDefaults,
} as const satisfies Record<AIProvider, DefaultsBuilder>;

type DefaultsForRoleParams = DefaultsBuilderParams & {
  provider: AIProvider;
};

export const defaultsForRole = ({
  role,
  provider,
  orgId,
  modelId,
}: DefaultsForRoleParams): Settings =>
  DEFAULTS_BUILDERS[provider]({ role, orgId, modelId });

// Fable 5 and Opus 4.7+ reject sampling overrides with a 400 on every
// request shape; they always run with provider-side defaults. Stripping
// in middleware (after the role defaults merge) covers both the role
// defaults and explicit call-site values, so no caller can reintroduce
// a sampling parameter for these models.
const fixedSamplingMiddleware: SingleMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    const {
      temperature: _temperature,
      topP: _topP,
      topK: _topK,
      ...rest
    } = params;
    return await Promise.resolve(rest);
  },
};

const withInstrumentation = (
  model: WrappableLanguageModel,
  ctx: {
    provider: AIProvider;
    decision: CachingDecision;
    role: ModelRole;
    modelId: string;
    organizationId: SafeId<"organization"> | null;
    serviceTier: AIRequestServiceTier;
    serviceTierTarget: ServiceTierProviderTarget;
    allowServiceTierFallback: boolean;
  },
): LanguageModel => {
  const middlewares: SingleMiddleware[] = [
    defaultSettingsMiddleware({
      settings: defaultsForRole({
        role: ctx.role,
        provider: ctx.provider,
        orgId: ctx.organizationId,
        modelId: ctx.modelId,
      }),
    }),
  ];
  if (
    ctx.provider === "anthropic" &&
    rejectsAnthropicSamplingParams(ctx.modelId)
  ) {
    middlewares.push(fixedSamplingMiddleware);
  }
  middlewares.push(
    cachingMiddleware(ctx.provider, ctx.decision),
    createServiceTierMiddleware(ctx.serviceTierTarget, ctx.serviceTier, {
      allowFallbackToStandard: ctx.allowServiceTierFallback,
    }),
  );
  if (isAIDevToolsEnabled()) {
    middlewares.push(devToolsMiddleware());
  }
  return wrapLanguageModel({
    model,
    middleware: middlewares,
  });
};

// -- Public API -------------------------------------------------

const providerRegion = (
  config: OrgAIProviderConfig,
): DataRegion | undefined => {
  switch (config.provider) {
    case "azure_foundry":
    case "huggingface":
      return undefined;
    default:
      return config.region;
  }
};

const getPrimaryOrgProvider = (config: OrgAIConfig): OrgAIProviderConfig =>
  config.providers.at(0) ?? panic("Org AI config has no configured providers");

const findOrgProviderConfig = (
  config: OrgAIConfig,
  provider: AIProvider,
): OrgAIProviderConfig | undefined =>
  config.providers.find((candidate) => candidate.provider === provider);

const getOrgProviderConfig = (
  config: OrgAIConfig,
  provider: AIProvider,
): OrgAIProviderConfig =>
  findOrgProviderConfig(config, provider) ??
  panic(`Org AI config has no ${provider} provider`);

export const isDeferredServiceTierAvailableForRole = (
  role: ModelRole,
  orgConfig: OrgAIConfig | null | undefined,
): boolean => {
  if (orgConfig) {
    const selection = orgConfig.overrideModels[role];
    const providerConfig = getOrgProviderConfig(orgConfig, selection.provider);
    return providerTargetForConfig(providerConfig) !== "none";
  }

  return (
    hasInstanceProvider() &&
    providerTargetForInstanceProvider(getActiveProvider()) !== "none"
  );
};

type AIModelRequestOptions = {
  promptCachingEnabled: boolean;
  scopeKey: string | null;
  organizationId: SafeId<"organization"> | null;
  serviceTier: AIRequestServiceTier;
  allowServiceTierFallback?: boolean;
};

export const validateDevModelOverride = (
  modelId: string,
  orgConfig: OrgAIConfig | null,
): Result<void, HandlerError<400>> => {
  const override = decodeModelOverride(modelId);
  if (!override.provider) {
    return Result.ok(undefined);
  }

  if (orgConfig) {
    if (findOrgProviderConfig(orgConfig, override.provider)) {
      return Result.ok(undefined);
    }
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          `Dev model override provider "${override.provider}" is not ` +
          "configured for this organization.",
      }),
    );
  }

  if (hasInstanceProviderCredentials(override.provider)) {
    return Result.ok(undefined);
  }
  return Result.err(
    new HandlerError({
      status: 400,
      message:
        `Dev model override provider "${override.provider}" is not ` +
        "configured for this deployment.",
    }),
  );
};

/**
 * Get a model instance for a logical role.
 *
 * Resolution order:
 * 1. BYOK: orgConfig with provider + key overrides the role
 * 2. Regional: orgConfig with only region uses instance
 *    provider routed through a regional endpoint
 * 3. Default: instance-level provider
 *
 * Callers must load OrgAIConfig once at session/connection
 * start, not per AI call.
 */
export const getModelForRole = (
  role: ModelRole,
  orgConfig: OrgAIConfig | null | undefined,
  options: AIModelRequestOptions,
): LanguageModel => {
  const {
    promptCachingEnabled,
    scopeKey,
    organizationId,
    serviceTier,
    allowServiceTierFallback = true,
  } = options;
  // BYOK path: org selects a model for each role through
  // one of its configured provider credentials.
  if (orgConfig) {
    const selection = orgConfig.overrideModels[role];
    const providerConfig = getOrgProviderConfig(orgConfig, selection.provider);
    const factory = getCachedFactory(providerConfig);
    const decision = resolveCaching({ promptCachingEnabled, role, scopeKey });
    return withInstrumentation(factory(selection.modelId), {
      provider: providerConfig.provider,
      decision,
      role,
      modelId: selection.modelId,
      organizationId,
      serviceTier,
      serviceTierTarget: providerTargetForConfig(providerConfig),
      allowServiceTierFallback,
    });
  }

  // Default instance path. requireAIAvailable() gates the entry
  // point but only checks "any provider available" — it returns
  // ok if orgConfig is non-null without verifying the org's BYOK
  // covers the requested role. So when an org has partial BYOK
  // overrides and the role falls through here on a deployment
  // with REQUIRE_PERSONAL_AI_KEY=true, getActiveProvider() panics
  // with a generic error and the user sees a 500. Throw a typed
  // HandlerError instead so the request boundary returns 403 with
  // an actionable message.
  if (!hasInstanceProvider()) {
    throw byokRoleNotConfiguredError(role);
  }
  const provider = getActiveProvider();
  const modelId = MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[provider][role];
  const decision = resolveCaching({ promptCachingEnabled, role, scopeKey });
  return withInstrumentation(getInstanceFactory()(modelId), {
    provider,
    decision,
    role,
    modelId,
    organizationId,
    serviceTier,
    serviceTierTarget: providerTargetForInstanceProvider(provider),
    allowServiceTierFallback,
  });
};

const byokRoleNotConfiguredError = (role: ModelRole): HandlerError =>
  new HandlerError({
    status: 403,
    message:
      `AI is not available for the "${role}" role on this deployment. ` +
      "Configure an organization-wide AI key (or include this role in " +
      "the BYOK override list) in organization settings.",
  });

export const getModelInfoForRole = (
  role: ModelRole,
  orgConfig?: OrgAIConfig | null,
): ResolvedModelInfo => {
  if (orgConfig) {
    const selection = orgConfig.overrideModels[role];
    const providerConfig = getOrgProviderConfig(orgConfig, selection.provider);
    return {
      keySource: "byok",
      provider: providerConfig.provider,
      modelId: selection.modelId,
      region: providerRegion(providerConfig),
    };
  }

  const provider = getActiveProvider();
  return {
    keySource: "instance",
    provider,
    modelId: MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[provider][role],
  };
};

export const getModelInfoById = (
  modelId: string,
  orgConfig?: OrgAIConfig | null,
): ResolvedModelInfo => {
  const override = decodeModelOverride(modelId);
  if (orgConfig) {
    const providerConfig = override.provider
      ? getOrgProviderConfig(orgConfig, override.provider)
      : getPrimaryOrgProvider(orgConfig);
    return {
      keySource: "byok",
      provider: providerConfig.provider,
      modelId: override.modelId,
      region: providerRegion(providerConfig),
    };
  }

  const provider = override.provider ?? getActiveProvider();
  return {
    keySource: "instance",
    provider,
    modelId: override.modelId,
  };
};

/**
 * Get a model instance by explicit model ID.
 *
 * Routes the ID through the active provider (or org
 * provider if BYOK config is supplied). Used for
 * dev model picker overrides.
 */
export const getModelById = (
  modelId: string,
  orgConfig: OrgAIConfig | null | undefined,
  options: AIModelRequestOptions & { role: ModelRole },
): LanguageModel => {
  const override = decodeModelOverride(modelId);
  const {
    promptCachingEnabled,
    scopeKey,
    role,
    organizationId,
    serviceTier,
    allowServiceTierFallback = true,
  } = options;
  const decision = resolveCaching({ promptCachingEnabled, role, scopeKey });
  if (orgConfig) {
    const providerConfig = override.provider
      ? getOrgProviderConfig(orgConfig, override.provider)
      : getPrimaryOrgProvider(orgConfig);
    return withInstrumentation(
      getCachedFactory(providerConfig)(override.modelId),
      {
        provider: providerConfig.provider,
        decision,
        role,
        modelId: override.modelId,
        organizationId,
        serviceTier,
        serviceTierTarget: providerTargetForConfig(providerConfig),
        allowServiceTierFallback,
      },
    );
  }
  if (override.provider) {
    return withInstrumentation(
      createModelFactory({ provider: override.provider })(override.modelId),
      {
        provider: override.provider,
        decision,
        role,
        modelId: override.modelId,
        organizationId,
        serviceTier,
        serviceTierTarget: providerTargetForInstanceProvider(override.provider),
        allowServiceTierFallback,
      },
    );
  }
  const provider = getActiveProvider();
  return withInstrumentation(getInstanceFactory()(override.modelId), {
    provider,
    decision,
    role,
    modelId: override.modelId,
    organizationId,
    serviceTier,
    serviceTierTarget: providerTargetForInstanceProvider(provider),
    allowServiceTierFallback,
  });
};
