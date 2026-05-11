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
 *
 * When AI_PROVIDER is not set, auto-detects from available
 * API keys: OPENROUTER → Google → OpenAI → Azure → Anthropic → Mistral.
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createMistral, mistral } from "@ai-sdk/mistral";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import { panic, Result } from "better-result";

import { env } from "@/api/env";
import {
  AZURE_FOUNDRY_DEFAULT_API_VERSION,
  normalizeAzureFoundryBaseURL,
} from "@/api/lib/azure-foundry";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// -- Types ------------------------------------------------------

/**
 * Logical model roles. Call sites declare *what* they need,
 * not *which* model to use.
 *
 * - fast: classification, extraction, short generation
 * - chat: conversational with tool use and streaming
 * - reasoning: complex multi-step legal analysis
 * - pdf: native PDF/image understanding
 */
export type ModelRole = "fast" | "chat" | "reasoning" | "pdf";

export const MODEL_ROLES = [
  "fast",
  "chat",
  "reasoning",
  "pdf",
] as const satisfies readonly ModelRole[];

export type AIProvider =
  | "google"
  | "openrouter"
  | "openai"
  | "azure_foundry"
  | "anthropic"
  | "mistral"
  | "openai_compatible";

// -- Default model IDs per provider -----------------------------

export const DEFAULT_MODELS = {
  google: {
    fast: "gemini-3.1-flash-lite-preview",
    chat: "gemini-3.1-flash-lite-preview",
    reasoning: "gemini-3.1-pro-preview",
    pdf: "gemini-3.1-flash-lite-preview",
  },
  openrouter: {
    fast: "google/gemini-3.1-flash-lite-preview",
    chat: "google/gemini-3.1-flash-lite-preview",
    reasoning: "google/gemini-3.1-pro-preview",
    pdf: "google/gemini-3.1-flash-lite-preview",
  },
  openai: {
    fast: "gpt-5.4-nano",
    chat: "gpt-5.4-mini",
    reasoning: "gpt-5.4",
    pdf: "gpt-5.4",
  },
  azure_foundry: {
    fast: "gpt-5.4-nano",
    chat: "gpt-5.4-mini",
    reasoning: "gpt-5.4",
    pdf: "gpt-5.4",
  },
  anthropic: {
    fast: "claude-haiku-4-5-20251001",
    chat: "claude-sonnet-4-6",
    reasoning: "claude-sonnet-4-6",
    pdf: "claude-sonnet-4-6",
  },
  mistral: {
    fast: "mistral-small-latest",
    chat: "mistral-large-latest",
    reasoning: "magistral-medium-latest",
    pdf: "mistral-large-latest",
  },
  openai_compatible: {
    fast: "default",
    chat: "default",
    reasoning: "default",
    pdf: "default",
  },
} as const satisfies Record<AIProvider, Record<ModelRole, string>>;

/**
 * BYOK-offered model IDs per provider. Server-side allowlist
 * mirroring the picker catalog in
 * apps/web/src/components/ai-config-role-models.logic.ts —
 * keep the two in sync. The frontend list is not a security
 * boundary; this is what the API will accept.
 *
 * Limited to providers BYOK supports (no openai_compatible).
 */
export const BYOK_MODEL_OPTIONS = {
  google: [
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
  anthropic: [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ],
  mistral: [
    "mistral-medium-3-5",
    "mistral-large-latest",
    "mistral-small-latest",
    "magistral-medium-latest",
    "magistral-small-latest",
  ],
  openai: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"],
  azure_foundry: [],
  openrouter: [
    "google/gemini-3-flash-preview",
    "google/gemini-3.1-pro-preview",
    "google/gemini-2.5-flash-lite",
    "anthropic/claude-opus-4.5",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
  ],
} as const satisfies Record<
  Exclude<AIProvider, "openai_compatible">,
  readonly string[]
>;

export type BYOKProvider = keyof typeof BYOK_MODEL_OPTIONS;

const CUSTOM_BYOK_MODEL_PROVIDERS = new Set<BYOKProvider>(["azure_foundry"]);

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

  return panic(
    "No AI provider configured. Set AI_PROVIDER or " +
      "provide at least one API key: " +
      "GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, " +
      "OPENAI_API_KEY, AZURE_API_KEY, ANTHROPIC_API_KEY, or MISTRAL_API_KEY.",
  );
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
  // Mock provider stands in for any real key.
  if (env.USE_MOCK_AI) {
    return true;
  }
  // Auto-detect path: any single provider key is enough.
  const hasAnyKey = !!(
    env.OPENROUTER_API_KEY ||
    env.GOOGLE_GENERATIVE_AI_API_KEY ||
    env.GOOGLE_AI_API_KEY_EU ||
    env.GOOGLE_AI_API_KEY_CH ||
    env.OPENAI_API_KEY ||
    (env.AZURE_API_KEY && (env.AZURE_RESOURCE_NAME || env.AZURE_BASE_URL)) ||
    env.ANTHROPIC_API_KEY ||
    env.MISTRAL_API_KEY
  );
  if (!env.AI_PROVIDER) {
    return hasAnyKey;
  }
  // Explicit provider: each provider has its own credential
  // requirement. Mirror resolveProvider's expectations so the
  // gate matches what the model factory would actually accept.
  switch (env.AI_PROVIDER) {
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
    default:
      return false;
  }
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
   * configured provider; the update endpoint enforces this
   * and rejects orphan providers (configured but unused).
   */
  overrideModels: Record<ModelRole, OrgAIModelSelection>;
};

export type StandardOrgAIProviderConfig = {
  provider: Exclude<AIProvider, "azure_foundry">;
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

export type OrgAIProviderConfig =
  | StandardOrgAIProviderConfig
  | AzureFoundryOrgAIProviderConfig;

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
  if (config.provider === "azure_foundry") {
    hasher.update(config.baseURL);
    hasher.update(resolveAzureApiVersion(config.apiVersion));
  } else {
    hasher.update(config.region ?? "global");
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
    ...(config.provider === "azure_foundry"
      ? { baseURL: config.baseURL, apiVersion: config.apiVersion }
      : { region: config.region }),
  });
  byokCache.set(key, factory);
  return factory;
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

const withLocalAIDevTools = (model: WrappableLanguageModel): LanguageModel => {
  if (!isAIDevToolsEnabled()) {
    return model;
  }
  return wrapLanguageModel({
    model,
    middleware: devToolsMiddleware(),
  });
};

// -- Public API -------------------------------------------------

const getPrimaryOrgProvider = (config: OrgAIConfig): OrgAIProviderConfig =>
  config.providers.at(0) ?? panic("Org AI config has no configured providers");

const getOrgProviderConfig = (
  config: OrgAIConfig,
  provider: AIProvider,
): OrgAIProviderConfig =>
  config.providers.find((candidate) => candidate.provider === provider) ??
  panic(`Org AI config has no ${provider} provider`);

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
  orgConfig?: OrgAIConfig | null,
): LanguageModel => {
  // BYOK path: org selects a model for each role through
  // one of its configured provider credentials.
  if (orgConfig) {
    const selection = orgConfig.overrideModels[role];
    const providerConfig = getOrgProviderConfig(orgConfig, selection.provider);
    const factory = getCachedFactory(providerConfig);
    return withLocalAIDevTools(factory(selection.modelId));
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
  const modelId =
    MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[getActiveProvider()][role];
  return withLocalAIDevTools(getInstanceFactory()(modelId));
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
      region:
        providerConfig.provider === "azure_foundry"
          ? undefined
          : providerConfig.region,
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
  if (orgConfig) {
    const providerConfig = getPrimaryOrgProvider(orgConfig);
    return {
      keySource: "byok",
      provider: providerConfig.provider,
      modelId,
      region:
        providerConfig.provider === "azure_foundry"
          ? undefined
          : providerConfig.region,
    };
  }

  return {
    keySource: "instance",
    provider: getActiveProvider(),
    modelId,
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
  orgConfig?: OrgAIConfig | null,
): LanguageModel => {
  if (orgConfig) {
    return withLocalAIDevTools(
      getCachedFactory(getPrimaryOrgProvider(orgConfig))(modelId),
    );
  }
  return withLocalAIDevTools(getInstanceFactory()(modelId));
};
