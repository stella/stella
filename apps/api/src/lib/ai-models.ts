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
 * - "anthropic": Anthropic (ANTHROPIC_API_KEY)
 * - "openai_compatible": Any OpenAI-compatible endpoint
 *   (OPENAI_API_KEY + AI_PROVIDER_BASE_URL)
 *
 * When AI_PROVIDER is not set, auto-detects from available
 * API keys: OPENROUTER → Google → OpenAI → Anthropic.
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import { panic, Result } from "better-result";

import { env } from "@/api/env";
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

export type AIProvider =
  | "google"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "openai_compatible";

// -- Default model IDs per provider -----------------------------

const DEFAULT_MODELS = {
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
  anthropic: {
    fast: "claude-haiku-4-5-20251001",
    chat: "claude-sonnet-4-6",
    reasoning: "claude-sonnet-4-6",
    pdf: "claude-sonnet-4-6",
  },
  openai_compatible: {
    fast: "default",
    chat: "default",
    reasoning: "default",
    pdf: "default",
  },
} as const satisfies Record<AIProvider, Record<ModelRole, string>>;

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
  if (env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }

  return panic(
    "No AI provider configured. Set AI_PROVIDER or " +
      "provide at least one API key: " +
      "GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, " +
      "OPENAI_API_KEY, or ANTHROPIC_API_KEY.",
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
    env.ANTHROPIC_API_KEY
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
    case "anthropic":
      return !!env.ANTHROPIC_API_KEY;
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

const createModelFactory = (
  provider: AIProvider,
  apiKey?: string,
  baseURL?: string,
  region?: DataRegion,
): ModelFactory => {
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
    case "anthropic": {
      if (apiKey) {
        const client = createAnthropic({ apiKey });
        return (id) => client(id);
      }
      return (id) => anthropic(id);
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

// -- BYOK org config --------------------------------------------

/**
 * Organization-level AI configuration (BYOK).
 *
 * Loaded once at connection/session establishment and
 * threaded through to getModelForRole. Never fetched
 * per AI call.
 */
export type OrgAIConfig = {
  provider: AIProvider;
  /** Decrypted API key. */
  apiKey: string;
  /** For openai_compatible only. */
  baseURL?: string | undefined;
  /**
   * Which roles use the org key. Roles not listed fall
   * back to the instance-level provider. Empty array or
   * omitted = override all roles.
   */
  overrideRoles?: ModelRole[] | undefined;
  /**
   * Data sovereignty region. When set, AI calls are
   * routed to region-specific endpoints (e.g. Vertex AI
   * europe-west4 for EU).
   */
  region?: DataRegion | undefined;
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
 * hash of (provider + apiKey + baseURL + region) so we
 * don't recreate HTTP clients on every call within the
 * same connection. Uses a truncated SHA-256 digest to
 * avoid holding full secrets as map keys.
 */
const BYOK_CACHE_MAX = 64;
const byokCache = new Map<string, ModelFactory>();

const byokCacheKey = (config: OrgAIConfig): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(config.apiKey);
  const hash = hasher.digest("hex").slice(0, 16);
  return `${config.provider}:${hash}:${config.baseURL ?? ""}:${config.region ?? "global"}`;
};

const getCachedFactory = (config: OrgAIConfig): ModelFactory => {
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
  const factory = createModelFactory(
    config.provider,
    config.apiKey,
    config.baseURL,
    config.region,
  );
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
  _instanceFactory ??= createModelFactory(getActiveProvider());
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

/** Regional instance factory cache (non-BYOK). */
const regionalFactoryCache = new Map<DataRegion, ModelFactory>();

const getRegionalInstanceFactory = (region: DataRegion): ModelFactory => {
  const cached = regionalFactoryCache.get(region);
  if (cached) {
    return cached;
  }
  const factory = createModelFactory(
    getActiveProvider(),
    undefined,
    undefined,
    region,
  );
  regionalFactoryCache.set(region, factory);
  return factory;
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
  orgConfig?: OrgAIConfig | null,
): LanguageModel => {
  // BYOK path: org overrides this role with their own key.
  if (orgConfig) {
    const roles = orgConfig.overrideRoles;
    const shouldOverride = !roles || roles.length === 0 || roles.includes(role);

    if (shouldOverride) {
      const factory = getCachedFactory(orgConfig);
      const modelId = DEFAULT_MODELS[orgConfig.provider][role];
      return withLocalAIDevTools(factory(modelId));
    }

    // Region-only path: org has a region booster but this
    // role falls back to instance provider. Route through
    // the regional endpoint.
    if (orgConfig.region && orgConfig.region !== "global") {
      const factory = getRegionalInstanceFactory(orgConfig.region);
      const modelId =
        MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[getActiveProvider()][role];
      return withLocalAIDevTools(factory(modelId));
    }
  }

  // Default instance path.
  const modelId =
    MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[getActiveProvider()][role];
  return withLocalAIDevTools(getInstanceFactory()(modelId));
};

export const getModelInfoForRole = (
  role: ModelRole,
  orgConfig?: OrgAIConfig | null,
): ResolvedModelInfo => {
  if (orgConfig) {
    const roles = orgConfig.overrideRoles;
    const shouldOverride = !roles || roles.length === 0 || roles.includes(role);

    if (shouldOverride) {
      return {
        keySource: "byok",
        provider: orgConfig.provider,
        modelId: DEFAULT_MODELS[orgConfig.provider][role],
        region: orgConfig.region,
      };
    }
  }

  const provider = getActiveProvider();
  return {
    keySource: "instance",
    provider,
    modelId: MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[provider][role],
    region: orgConfig?.region,
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
    return withLocalAIDevTools(getCachedFactory(orgConfig)(modelId));
  }
  return withLocalAIDevTools(getInstanceFactory()(modelId));
};
