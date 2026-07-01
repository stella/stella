import { HarmBlockThreshold, HarmCategory } from "@google/genai";
import { createModel, extendAdapter } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import type { AnthropicTextProviderOptions } from "@tanstack/ai-anthropic";
import { createBedrockConverse } from "@tanstack/ai-bedrock";
import type { BedrockConverseProviderOptions } from "@tanstack/ai-bedrock";
import { createGeminiChat } from "@tanstack/ai-gemini";
import type { GeminiTextProviderOptions } from "@tanstack/ai-gemini";
import { createMistralText } from "@tanstack/ai-mistral";
import type { MistralTextProviderOptions } from "@tanstack/ai-mistral";
import { createOpenaiChat } from "@tanstack/ai-openai";
import type { OpenAITextProviderOptions } from "@tanstack/ai-openai";
import {
  createOpenRouterResponsesText,
  type OpenRouterResponsesTextProviderOptions,
} from "@tanstack/ai-openrouter";
import { Result, panic } from "better-result";

import {
  AI_PROVIDERS,
  ANTHROPIC_ADAPTIVE_THINKING_MODELS,
  ANTHROPIC_FIXED_SAMPLING_MODELS,
  BYOK_MODEL_OPTIONS,
  DEFAULT_MODELS,
  isBYOKProviderRoleSupported,
} from "@stll/ai-catalog";
import type { AIProvider, BYOKProvider, ModelRole } from "@stll/ai-catalog";

import { env } from "@/api/env";
import type {
  AIRequestServiceTier,
  DataRegion,
  OrgAIConfig,
  OrgAIProviderConfig,
} from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const AI_PROVIDER_VALUES = new Set<string>(AI_PROVIDERS);
const ANTHROPIC_LEGACY_THINKING_BUDGET_TOKENS = 10_000;
const BYOK_CACHE_MAX = 64;
const OPENROUTER_RESPONSES_MODEL_OPTIONS: OpenRouterResponsesTextProviderOptions =
  {};

const isAIProvider = (value: string): value is AIProvider =>
  AI_PROVIDER_VALUES.has(value);

export { AI_PROVIDERS, BYOK_MODEL_OPTIONS, DEFAULT_MODELS };
export { MODEL_ROLES } from "@stll/ai-catalog";
export type { AIProvider, BYOKProvider, ModelRole };

type TanStackTextAdapterFactory = (modelId: string) => AnyTextAdapter;

export type TanStackTextProvider = Exclude<
  AIProvider,
  "azure_foundry" | "huggingface" | "openai_compatible"
>;

const INSTANCE_PROVIDER_PREFERENCE = [
  "openrouter",
  "google",
  "openai",
  "anthropic",
  "bedrock",
  "mistral",
] as const satisfies readonly TanStackTextProvider[];

type AnthropicAdaptiveThinking = {
  type: "adaptive";
  display?: "omitted" | "summarized" | undefined;
};

type StellaAnthropicThinking =
  | NonNullable<AnthropicTextProviderOptions["thinking"]>
  | AnthropicAdaptiveThinking;

type StellaAnthropicTextProviderOptions = Omit<
  AnthropicTextProviderOptions,
  "thinking"
> & {
  thinking?: StellaAnthropicThinking | undefined;
};

type StellaGeminiTextProviderOptions = GeminiTextProviderOptions & {
  serviceTier?: "standard" | "flex" | "priority" | undefined;
};

export type TanStackAIProviderUnsupportedReason =
  | "provider-not-implemented"
  | "regional-routing-not-implemented";

export type TanStackAIProviderSupport =
  | { supported: true }
  | {
      supported: false;
      reason: TanStackAIProviderUnsupportedReason;
      message: string;
    };

type TanStackModelOptionsByProvider = {
  anthropic: StellaAnthropicTextProviderOptions;
  bedrock: BedrockConverseProviderOptions;
  google: StellaGeminiTextProviderOptions;
  mistral: MistralTextProviderOptions;
  openai: OpenAITextProviderOptions;
  openrouter: OpenRouterResponsesTextProviderOptions;
};

export type TanStackModelOptions<
  TProvider extends TanStackTextProvider = TanStackTextProvider,
> = TanStackModelOptionsByProvider[TProvider];

type ResolvedTanStackTextModelForProvider<
  TProvider extends TanStackTextProvider,
> = {
  adapter: AnyTextAdapter;
  keySource: "byok" | "instance";
  provider: TProvider;
  modelId: string;
  modelOptions: TanStackModelOptions<TProvider>;
  region?: DataRegion | undefined;
};

export type ResolvedTanStackTextModel = {
  [TProvider in TanStackTextProvider]: ResolvedTanStackTextModelForProvider<TProvider>;
}[TanStackTextProvider];

export type ResolvedTanStackTextModelInfo = Pick<
  ResolvedTanStackTextModel,
  "keySource" | "modelId" | "provider" | "region"
>;

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

  const allowed: readonly string[] = BYOK_MODEL_OPTIONS[provider];
  return allowed.includes(modelId);
};

export const isAllowedBYOKModelForRole = ({
  provider,
  modelId,
  role,
}: {
  provider: AIProvider;
  modelId: string;
  role: ModelRole;
}): boolean => {
  if (!isBYOKProvider(provider)) {
    return false;
  }

  const allowed: readonly string[] = BYOK_MODEL_OPTIONS[provider];
  return (
    allowed.includes(modelId) && isBYOKProviderRoleSupported({ provider, role })
  );
};

type ModelOverride = {
  modelId: string;
  provider?: AIProvider | undefined;
};

type TanStackModelFactoryOptions = {
  provider: AIProvider;
  apiKey?: string | undefined;
  region?: DataRegion | undefined;
};

let mockTextAdapterFactory: TanStackTextAdapterFactory | undefined;

export const registerTanStackMockTextAdapterFactory = (
  factory: TanStackTextAdapterFactory,
): void => {
  mockTextAdapterFactory = factory;
};

const decodeModelOverride = (value: string): ModelOverride => {
  const [providerRaw, ...modelParts] = value.split("::");
  const modelId = modelParts.join("::");

  if (providerRaw && modelId && isAIProvider(providerRaw)) {
    return { provider: providerRaw, modelId };
  }

  return { modelId: value };
};

export const resolveTanStackAIProviderSupport = ({
  provider,
  region,
}: {
  provider: AIProvider;
  region?: DataRegion | undefined;
}): TanStackAIProviderSupport => {
  if (provider === "azure_foundry") {
    return {
      supported: false,
      reason: "provider-not-implemented",
      message:
        "Azure AI Foundry is not supported by the TanStack AI integration yet.",
    };
  }

  if (provider === "openai_compatible") {
    return {
      supported: false,
      reason: "provider-not-implemented",
      message:
        "OpenAI-compatible custom providers are not supported by the " +
        "TanStack AI integration yet.",
    };
  }

  if (provider === "huggingface") {
    return {
      supported: false,
      reason: "provider-not-implemented",
      message:
        "Hugging Face is not supported by the TanStack AI integration yet.",
    };
  }

  if (provider === "google" && region && region !== "global") {
    return {
      supported: false,
      reason: "regional-routing-not-implemented",
      message:
        "Google regional routing is not supported by the TanStack AI " +
        "integration yet. Use the global Google Gemini endpoint or another " +
        "supported provider.",
    };
  }

  return { supported: true };
};

export const isTanStackAIProviderSupported = ({
  provider,
  region,
}: {
  provider: AIProvider;
  region?: DataRegion | undefined;
}): boolean => resolveTanStackAIProviderSupport({ provider, region }).supported;

const assertTanStackAIProviderSupport = ({
  provider,
  region,
}: {
  provider: AIProvider;
  region?: DataRegion | undefined;
}): void => {
  const support = resolveTanStackAIProviderSupport({ provider, region });
  if (support.supported) {
    return;
  }

  throw new HandlerError({
    status: 400,
    message: support.message,
  });
};

const resolveTanStackTextProvider = ({
  provider,
  region,
}: {
  provider: AIProvider;
  region?: DataRegion | undefined;
}): TanStackTextProvider => {
  assertTanStackAIProviderSupport({ provider, region });

  switch (provider) {
    case "google":
    case "anthropic":
    case "bedrock":
    case "mistral":
    case "openai":
    case "openrouter":
      return provider;
    case "azure_foundry":
    case "huggingface":
    case "openai_compatible":
      return panic(
        `Unsupported TanStack AI provider passed support assertion: ${provider}`,
      );
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const missingProviderCredentialError = (
  provider: AIProvider,
  envVar: string,
): HandlerError<403> =>
  new HandlerError({
    status: 403,
    message: `${envVar} is required for TanStack AI provider "${provider}".`,
  });

const requireCredential = (
  provider: AIProvider,
  value: string | undefined,
  envVar: string,
): string => {
  if (value) {
    return value;
  }
  throw missingProviderCredentialError(provider, envVar);
};

const createExtendedGeminiAdapter = (
  modelId: string,
  apiKey: string,
): AnyTextAdapter => {
  const gemini = extendAdapter(createGeminiChat, [
    createModel(modelId, {
      input: ["text", "image", "document"] as const,
      features: ["structured_outputs"] as const,
    }),
  ]);
  return gemini(modelId, apiKey);
};

const createExtendedAnthropicAdapter = (
  modelId: string,
  apiKey: string,
): AnyTextAdapter => {
  const anthropic = extendAdapter(createAnthropicChat, [
    createModel(modelId, {
      input: ["text", "image", "document"] as const,
      features: ["structured_outputs"] as const,
    }),
  ]);
  return anthropic(modelId, apiKey);
};

const createExtendedOpenAIAdapter = (
  modelId: string,
  apiKey: string,
): AnyTextAdapter => {
  const openai = extendAdapter(createOpenaiChat, [
    createModel(modelId, {
      input: ["text", "image", "document"] as const,
      features: ["structured_outputs"] as const,
    }),
  ]);
  return openai(modelId, apiKey);
};

const createExtendedOpenRouterAdapter = (
  modelId: string,
  apiKey: string,
): AnyTextAdapter => {
  const openrouter = extendAdapter(createOpenRouterResponsesText, [
    createModel(modelId, {
      input: ["text", "image", "document"] as const,
      features: ["structured_outputs"] as const,
      modelOptions: OPENROUTER_RESPONSES_MODEL_OPTIONS,
    }),
  ]);
  return openrouter(modelId, apiKey);
};

const createExtendedMistralAdapter = (
  modelId: string,
  apiKey: string,
): AnyTextAdapter => {
  const mistral = extendAdapter(createMistralText, [
    createModel(modelId, {
      input: ["text", "image"] as const,
      features: ["structured_outputs"] as const,
    }),
  ]);
  return mistral(modelId, apiKey);
};

const createExtendedBedrockAdapter = (
  modelId: string,
  apiKey: string,
): AnyTextAdapter => {
  const bedrock = extendAdapter(createBedrockConverse, [
    createModel(modelId, {
      input: ["text", "image", "document"] as const,
      features: ["structured_outputs"] as const,
    }),
  ]);
  return bedrock(modelId, apiKey);
};

const createTanStackTextAdapterFactory = ({
  provider,
  apiKey,
  region,
}: TanStackModelFactoryOptions): TanStackTextAdapterFactory => {
  if (env.USE_MOCK_AI && mockTextAdapterFactory) {
    return mockTextAdapterFactory;
  }

  const supportedProvider = resolveTanStackTextProvider({ provider, region });

  switch (supportedProvider) {
    case "google": {
      const key = requireCredential(
        supportedProvider,
        apiKey ?? env.GOOGLE_GENERATIVE_AI_API_KEY,
        "GOOGLE_GENERATIVE_AI_API_KEY",
      );
      return (modelId) => createExtendedGeminiAdapter(modelId, key);
    }
    case "anthropic": {
      const key = requireCredential(
        supportedProvider,
        apiKey ?? env.ANTHROPIC_API_KEY,
        "ANTHROPIC_API_KEY",
      );
      return (modelId) => createExtendedAnthropicAdapter(modelId, key);
    }
    case "bedrock": {
      const key = requireCredential(
        supportedProvider,
        apiKey ?? env.BEDROCK_API_KEY,
        "BEDROCK_API_KEY",
      );
      return (modelId) => createExtendedBedrockAdapter(modelId, key);
    }
    case "openai": {
      const key = requireCredential(
        supportedProvider,
        apiKey ?? env.OPENAI_API_KEY,
        "OPENAI_API_KEY",
      );
      return (modelId) => createExtendedOpenAIAdapter(modelId, key);
    }
    case "openrouter": {
      const key = requireCredential(
        supportedProvider,
        apiKey ?? env.OPENROUTER_API_KEY,
        "OPENROUTER_API_KEY",
      );
      return (modelId) => createExtendedOpenRouterAdapter(modelId, key);
    }
    case "mistral": {
      const key = requireCredential(
        supportedProvider,
        apiKey ?? env.MISTRAL_API_KEY,
        "MISTRAL_API_KEY",
      );
      return (modelId) => createExtendedMistralAdapter(modelId, key);
    }
    default: {
      const _exhaustive: never = supportedProvider;
      return _exhaustive;
    }
  }
};

const hasInstanceProviderCredentials = (provider: AIProvider): boolean => {
  if (env.REQUIRE_PERSONAL_AI_KEY) {
    return false;
  }
  if (env.USE_MOCK_AI && mockTextAdapterFactory) {
    return true;
  }

  switch (provider) {
    case "google":
      return !!env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "openrouter":
      return !!env.OPENROUTER_API_KEY;
    case "openai":
      return !!env.OPENAI_API_KEY;
    case "anthropic":
      return !!env.ANTHROPIC_API_KEY;
    case "bedrock":
      return !!env.BEDROCK_API_KEY;
    case "mistral":
      return !!env.MISTRAL_API_KEY;
    case "openai_compatible":
      return !!(env.OPENAI_API_KEY && env.AI_PROVIDER_BASE_URL);
    case "huggingface":
      return !!(env.HUGGINGFACE_API_KEY && env.HUGGINGFACE_BASE_URL);
    case "azure_foundry":
      return false;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const resolveProvider = (): AIProvider => {
  if (env.AI_PROVIDER) {
    return env.AI_PROVIDER;
  }
  if (env.USE_MOCK_AI && mockTextAdapterFactory) {
    return "google";
  }

  for (const provider of INSTANCE_PROVIDER_PREFERENCE) {
    if (hasInstanceProviderCredentials(provider)) {
      return provider;
    }
  }

  return panic(
    "No TanStack AI provider configured. Set AI_PROVIDER or provide at " +
      "least one supported provider key.",
  );
};

export const hasTanStackInstanceProvider = (): boolean => {
  if (env.REQUIRE_PERSONAL_AI_KEY) {
    return false;
  }
  if (!env.AI_PROVIDER) {
    return AI_PROVIDERS.some(
      (provider) =>
        isTanStackAIProviderSupported({ provider }) &&
        hasInstanceProviderCredentials(provider),
    );
  }
  return (
    isTanStackAIProviderSupported({ provider: env.AI_PROVIDER }) &&
    hasInstanceProviderCredentials(env.AI_PROVIDER)
  );
};

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

const isDeferredServiceTier = (serviceTier: string): boolean =>
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

  const support = resolveTanStackAIProviderSupport({ provider, region });
  if (!support.supported) {
    return "standard";
  }

  return provider === "google" ||
    provider === "openai" ||
    provider === "openrouter"
    ? serviceTier
    : "standard";
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

const byokProviderRoleUnsupportedError = (
  provider: BYOKProvider,
  role: ModelRole,
): HandlerError<400> =>
  new HandlerError({
    status: 400,
    message:
      `${provider} is not available for the "${role}" AI role. ` +
      "Choose a provider that supports document input for PDF flows.",
  });

const supportsTanStackProviderRole = (
  provider: TanStackTextProvider,
  role: ModelRole,
): boolean =>
  isBYOKProvider(provider) && isBYOKProviderRoleSupported({ provider, role });

const assertTanStackProviderRoleSupport = (
  provider: TanStackTextProvider,
  role: ModelRole,
): void => {
  if (supportsTanStackProviderRole(provider, role)) {
    return;
  }

  if (isBYOKProvider(provider)) {
    throw byokProviderRoleUnsupportedError(provider, role);
  }

  panic("Unsupported TanStack AI role provider.");
};

export const requireTanStackAIAvailableForRole = ({
  orgConfig,
  role,
}: {
  orgConfig: OrgAIConfig | null;
  role: ModelRole;
}): Result<void, HandlerError> => {
  if (!orgConfig) {
    if (hasTanStackInstanceProvider()) {
      return Result.ok(undefined);
    }
    return Result.err(byokRoleNotConfiguredError(role));
  }

  const selection = orgConfig.overrideModels[role];
  const providerConfig = getOrgProviderConfig(orgConfig, selection.provider);
  const support = resolveTanStackAIProviderSupport({
    provider: providerConfig.provider,
    region: providerRegion(providerConfig),
  });

  if (support.supported) {
    if (
      isBYOKProvider(providerConfig.provider) &&
      !isBYOKProviderRoleSupported({
        provider: providerConfig.provider,
        role,
      })
    ) {
      return Result.err(
        byokProviderRoleUnsupportedError(providerConfig.provider, role),
      );
    }
    return Result.ok(undefined);
  }

  return Result.err(
    new HandlerError({
      status: 400,
      message: support.message,
    }),
  );
};

export const isDeferredServiceTierAvailableForRole = (
  role: ModelRole,
  orgConfig: OrgAIConfig | null | undefined,
): boolean => {
  if (orgConfig) {
    const selection = orgConfig.overrideModels[role];
    const providerConfig = getOrgProviderConfig(orgConfig, selection.provider);
    const region = providerRegion(providerConfig);
    return (
      resolveEffectiveServiceTierForProvider({
        provider: providerConfig.provider,
        region,
        serviceTier: "flex",
      }) === "flex"
    );
  }

  if (!hasTanStackInstanceProvider()) {
    return false;
  }

  return (
    resolveEffectiveServiceTierForProvider({
      provider: getActiveProvider(),
      serviceTier: "flex",
    }) === "flex"
  );
};

export const validateTanStackDevModelOverride = (
  modelId: string,
  orgConfig: OrgAIConfig | null,
): Result<void, HandlerError<400>> => {
  const override = decodeModelOverride(modelId);
  if (!override.provider) {
    return Result.ok(undefined);
  }

  const support = resolveTanStackAIProviderSupport({
    provider: override.provider,
  });
  if (!support.supported) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: support.message,
      }),
    );
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

const byokCache = new Map<string, TanStackTextAdapterFactory>();

const byokCacheKey = (config: OrgAIProviderConfig): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(config.provider);
  hasher.update(config.apiKey);
  switch (config.provider) {
    case "azure_foundry":
      hasher.update(config.baseURL);
      hasher.update(config.apiVersion ?? "");
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

const factoryExtras = (
  config: OrgAIProviderConfig,
): Pick<TanStackModelFactoryOptions, "region"> => {
  switch (config.provider) {
    case "azure_foundry":
    case "huggingface":
      return {};
    default:
      return { region: config.region };
  }
};

const getCachedFactory = (
  config: OrgAIProviderConfig,
): TanStackTextAdapterFactory => {
  const key = byokCacheKey(config);
  const cached = byokCache.get(key);
  if (cached) {
    return cached;
  }

  if (byokCache.size >= BYOK_CACHE_MAX) {
    const oldest = byokCache.keys().next().value;
    if (oldest !== undefined) {
      byokCache.delete(oldest);
    }
  }

  const factory = createTanStackTextAdapterFactory({
    provider: config.provider,
    apiKey: config.apiKey,
    ...factoryExtras(config),
  });
  byokCache.set(key, factory);
  return factory;
};

const getActiveProvider = (): AIProvider => resolveProvider();

const getInstanceFactory = (): TanStackTextAdapterFactory =>
  createTanStackTextAdapterFactory({
    provider: getActiveProvider(),
  });

const MODEL_OVERRIDES = {
  fast: env.AI_MODEL_FAST,
  chat: env.AI_MODEL_CHAT,
  reasoning: env.AI_MODEL_REASONING,
  pdf: env.AI_MODEL_PDF,
} satisfies Record<ModelRole, string | undefined>;

const GOOGLE_SAFETY_SETTINGS_BASELINE = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
] as const satisfies NonNullable<GeminiTextProviderOptions["safetySettings"]>;

const rejectsAnthropicSamplingParams = (modelId: string): boolean =>
  ANTHROPIC_FIXED_SAMPLING_MODELS.some((fixedModelId) =>
    modelId.includes(fixedModelId),
  );

const usesAnthropicAdaptiveThinking = (modelId: string): boolean =>
  ANTHROPIC_ADAPTIVE_THINKING_MODELS.some((adaptiveModelId) =>
    modelId.includes(adaptiveModelId),
  );

const anthropicThinkingForModel = (
  modelId: string,
): StellaAnthropicThinking => {
  if (usesAnthropicAdaptiveThinking(modelId)) {
    return { type: "adaptive" };
  }

  return {
    type: "enabled",
    budget_tokens: ANTHROPIC_LEGACY_THINKING_BUDGET_TOKENS,
  };
};

type TanStackModelOptionsForRoleInput<TProvider extends TanStackTextProvider> =
  {
    role: ModelRole;
    provider: TProvider;
    modelId: string;
    organizationId: SafeId<"organization"> | null;
  };

const tanStackGoogleModelOptionsForRole = ({
  role,
}: TanStackModelOptionsForRoleInput<"google">): GeminiTextProviderOptions => ({
  temperature: 0,
  thinkingConfig: {
    thinkingLevel: role === "reasoning" ? "HIGH" : "MINIMAL",
    includeThoughts: false,
  },
  safetySettings: GOOGLE_SAFETY_SETTINGS_BASELINE,
});

const tanStackAnthropicModelOptionsForRole = ({
  role,
  modelId,
}: TanStackModelOptionsForRoleInput<"anthropic">): StellaAnthropicTextProviderOptions => {
  if (role === "reasoning") {
    return {
      thinking: anthropicThinkingForModel(modelId),
    };
  }

  if (rejectsAnthropicSamplingParams(modelId)) {
    return {};
  }

  return {
    temperature: 0,
  };
};

const tanStackOpenAIModelOptionsForRole = ({
  role,
}: TanStackModelOptionsForRoleInput<"openai">): OpenAITextProviderOptions => {
  if (role !== "reasoning") {
    return { temperature: 0 };
  }
  return {
    temperature: 0,
    reasoning: { effort: "medium" },
  };
};

const tanStackOpenRouterModelOptionsForRole =
  (): OpenRouterResponsesTextProviderOptions => ({ temperature: 0 });

const tanStackMistralModelOptionsForRole = (): MistralTextProviderOptions => ({
  temperature: 0,
});

const tanStackBedrockModelOptionsForRole =
  (): BedrockConverseProviderOptions => ({ temperature: 0 });

export function tanStackModelOptionsForRole(
  input: TanStackModelOptionsForRoleInput<"google">,
): GeminiTextProviderOptions;
export function tanStackModelOptionsForRole(
  input: TanStackModelOptionsForRoleInput<"anthropic">,
): StellaAnthropicTextProviderOptions;
export function tanStackModelOptionsForRole(
  input: TanStackModelOptionsForRoleInput<"bedrock">,
): BedrockConverseProviderOptions;
export function tanStackModelOptionsForRole(
  input: TanStackModelOptionsForRoleInput<"mistral">,
): MistralTextProviderOptions;
export function tanStackModelOptionsForRole(
  input: TanStackModelOptionsForRoleInput<"openai">,
): OpenAITextProviderOptions;
export function tanStackModelOptionsForRole(
  input: TanStackModelOptionsForRoleInput<"openrouter">,
): OpenRouterResponsesTextProviderOptions;
export function tanStackModelOptionsForRole(
  input: TanStackModelOptionsForRoleInput<TanStackTextProvider>,
): TanStackModelOptions {
  const { provider } = input;
  switch (provider) {
    case "google":
      return tanStackGoogleModelOptionsForRole({
        role: input.role,
        provider,
        modelId: input.modelId,
        organizationId: input.organizationId,
      });
    case "anthropic":
      return tanStackAnthropicModelOptionsForRole({
        role: input.role,
        provider,
        modelId: input.modelId,
        organizationId: input.organizationId,
      });
    case "bedrock":
      return tanStackBedrockModelOptionsForRole();
    case "mistral":
      return tanStackMistralModelOptionsForRole();
    case "openai":
      return tanStackOpenAIModelOptionsForRole({
        role: input.role,
        provider,
        modelId: input.modelId,
        organizationId: input.organizationId,
      });
    case "openrouter":
      return tanStackOpenRouterModelOptionsForRole();
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

const byokRoleNotConfiguredError = (role: ModelRole): HandlerError =>
  new HandlerError({
    status: 403,
    message:
      `AI is not available for the "${role}" role on this deployment. ` +
      "Configure an organization-wide AI key (or include this role in " +
      "the BYOK override list) in organization settings.",
  });

type BuildResolvedTextModelBase<TProvider extends TanStackTextProvider> = {
  adapter: AnyTextAdapter;
  keySource: "byok" | "instance";
  modelId: string;
  organizationId: SafeId<"organization"> | null;
  provider: TProvider;
  region?: DataRegion | undefined;
  role: ModelRole;
};

type BuildResolvedTextModelWithOptions<TProvider extends TanStackTextProvider> =
  BuildResolvedTextModelBase<TProvider> & {
    modelOptions: TanStackModelOptions<TProvider>;
  };

const buildResolvedTextModelWithOptions = <
  TProvider extends TanStackTextProvider,
>({
  adapter,
  keySource,
  modelId,
  modelOptions,
  provider,
  region,
}: BuildResolvedTextModelWithOptions<TProvider>): ResolvedTanStackTextModelForProvider<TProvider> => ({
  adapter,
  keySource,
  provider,
  modelId,
  modelOptions,
  ...(region === undefined ? {} : { region }),
});

const buildResolvedTextModel = ({
  adapter,
  keySource,
  modelId,
  organizationId,
  provider,
  region,
  role,
}: {
  adapter: AnyTextAdapter;
  keySource: "byok" | "instance";
  modelId: string;
  organizationId: SafeId<"organization"> | null;
  provider: TanStackTextProvider;
  region?: DataRegion | undefined;
  role: ModelRole;
}): ResolvedTanStackTextModel => {
  switch (provider) {
    case "google":
      return buildResolvedTextModelWithOptions({
        adapter,
        keySource,
        provider,
        modelId,
        organizationId,
        modelOptions: tanStackGoogleModelOptionsForRole({
          role,
          provider,
          modelId,
          organizationId,
        }),
        ...(region === undefined ? {} : { region }),
        role,
      });
    case "anthropic":
      return buildResolvedTextModelWithOptions({
        adapter,
        keySource,
        provider,
        modelId,
        organizationId,
        modelOptions: tanStackAnthropicModelOptionsForRole({
          role,
          provider,
          modelId,
          organizationId,
        }),
        ...(region === undefined ? {} : { region }),
        role,
      });
    case "bedrock":
      return buildResolvedTextModelWithOptions({
        adapter,
        keySource,
        provider,
        modelId,
        organizationId,
        modelOptions: tanStackBedrockModelOptionsForRole(),
        ...(region === undefined ? {} : { region }),
        role,
      });
    case "mistral":
      return buildResolvedTextModelWithOptions({
        adapter,
        keySource,
        provider,
        modelId,
        organizationId,
        modelOptions: tanStackMistralModelOptionsForRole(),
        ...(region === undefined ? {} : { region }),
        role,
      });
    case "openai":
      return buildResolvedTextModelWithOptions({
        adapter,
        keySource,
        provider,
        modelId,
        organizationId,
        modelOptions: tanStackOpenAIModelOptionsForRole({
          role,
          provider,
          modelId,
          organizationId,
        }),
        ...(region === undefined ? {} : { region }),
        role,
      });
    case "openrouter":
      return buildResolvedTextModelWithOptions({
        adapter,
        keySource,
        provider,
        modelId,
        organizationId,
        modelOptions: tanStackOpenRouterModelOptionsForRole(),
        ...(region === undefined ? {} : { region }),
        role,
      });
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
};

const resolveByokTextModel = ({
  role,
  providerConfig,
  modelId,
  organizationId,
}: {
  role: ModelRole;
  providerConfig: OrgAIProviderConfig;
  modelId: string;
  organizationId: SafeId<"organization"> | null;
}): ResolvedTanStackTextModel => {
  const region = providerRegion(providerConfig);
  const provider = resolveTanStackTextProvider({
    provider: providerConfig.provider,
    region,
  });
  assertTanStackProviderRoleSupport(provider, role);

  const factory = getCachedFactory(providerConfig);
  return buildResolvedTextModel({
    adapter: factory(modelId),
    keySource: "byok",
    provider,
    modelId,
    region,
    role,
    organizationId,
  });
};

const resolveInstanceTextModel = ({
  role,
  modelId,
  provider,
  organizationId,
}: {
  role: ModelRole;
  modelId: string;
  provider: AIProvider;
  organizationId: SafeId<"organization"> | null;
}): ResolvedTanStackTextModel => {
  const supportedProvider = resolveTanStackTextProvider({ provider });
  assertTanStackProviderRoleSupport(supportedProvider, role);

  return buildResolvedTextModel({
    adapter: getInstanceFactory()(modelId),
    keySource: "instance",
    provider: supportedProvider,
    modelId,
    role,
    organizationId,
  });
};

export const getTanStackTextModelForRole = (
  role: ModelRole,
  orgConfig: OrgAIConfig | null | undefined,
  options: {
    organizationId: SafeId<"organization"> | null;
  },
): ResolvedTanStackTextModel => {
  if (orgConfig) {
    const selection = orgConfig.overrideModels[role];
    return resolveByokTextModel({
      role,
      providerConfig: getOrgProviderConfig(orgConfig, selection.provider),
      modelId: selection.modelId,
      organizationId: options.organizationId,
    });
  }

  if (!hasTanStackInstanceProvider()) {
    throw byokRoleNotConfiguredError(role);
  }

  const provider = getActiveProvider();
  const modelId = MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[provider][role];
  return resolveInstanceTextModel({
    role,
    modelId,
    provider,
    organizationId: options.organizationId,
  });
};

export const getTanStackTextModelInfoForRole = (
  role: ModelRole,
  orgConfig: OrgAIConfig | null | undefined,
  _options: {
    organizationId: SafeId<"organization"> | null;
  },
): ResolvedTanStackTextModelInfo => {
  if (orgConfig) {
    const selection = orgConfig.overrideModels[role];
    const providerConfig = getOrgProviderConfig(orgConfig, selection.provider);
    const region = providerRegion(providerConfig);
    const provider = resolveTanStackTextProvider({
      provider: providerConfig.provider,
      region,
    });
    assertTanStackProviderRoleSupport(provider, role);

    return {
      keySource: "byok",
      modelId: selection.modelId,
      provider,
      ...(region === undefined ? {} : { region }),
    };
  }

  if (!hasTanStackInstanceProvider()) {
    throw byokRoleNotConfiguredError(role);
  }

  const provider = getActiveProvider();
  const supportedProvider = resolveTanStackTextProvider({ provider });
  assertTanStackProviderRoleSupport(supportedProvider, role);
  return {
    keySource: "instance",
    modelId: MODEL_OVERRIDES[role] ?? DEFAULT_MODELS[provider][role],
    provider: supportedProvider,
  };
};

export const getTanStackTextModelById = (
  modelId: string,
  orgConfig: OrgAIConfig | null | undefined,
  options: {
    role: ModelRole;
    organizationId: SafeId<"organization"> | null;
  },
): ResolvedTanStackTextModel => {
  const override = decodeModelOverride(modelId);

  if (orgConfig) {
    const providerConfig = override.provider
      ? getOrgProviderConfig(orgConfig, override.provider)
      : getPrimaryOrgProvider(orgConfig);
    return resolveByokTextModel({
      role: options.role,
      providerConfig,
      modelId: override.modelId,
      organizationId: options.organizationId,
    });
  }

  if (!hasTanStackInstanceProvider() && !override.provider) {
    throw byokRoleNotConfiguredError(options.role);
  }

  const provider = override.provider ?? getActiveProvider();
  const supportedProvider = resolveTanStackTextProvider({ provider });
  const resolvedModelId = override.modelId;
  if (override.provider) {
    const factory = createTanStackTextAdapterFactory({
      provider: supportedProvider,
    });
    return buildResolvedTextModel({
      adapter: factory(resolvedModelId),
      keySource: "instance",
      provider: supportedProvider,
      modelId: resolvedModelId,
      role: options.role,
      organizationId: options.organizationId,
    });
  }

  return resolveInstanceTextModel({
    role: options.role,
    modelId: resolvedModelId,
    provider: supportedProvider,
    organizationId: options.organizationId,
  });
};
