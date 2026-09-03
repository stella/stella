/**
 * Canonical AI provider and model catalog.
 *
 * Single source of truth for every provider/model identifier stella
 * offers. Imported by the API runtime
 * (`apps/api/src/lib/tanstack-ai-models.ts`)
 * and the BYOK settings UI (`apps/web`), so the picker can never offer
 * a model the backend rejects, and vice versa.
 *
 * Pure data: no provider SDKs, no env access, no side effects. This is
 * deliberate so scripts (the nightly upstream-validation check) and
 * both apps can import it cheaply. Keep it that way. The only runtime
 * dependency is valibot, used solely to construct branded types the
 * same way the rest of the repo does.
 *
 * Model IDs go stale when providers rename or retire models. The
 * nightly `model-catalog-upstream` check
 * (`packages/scripts/src/model-catalog-upstream.ts`) validates every
 * ID here against live provider/aggregator listings so a retired model
 * fails CI instead of 400-ing a user at runtime.
 */
import * as v from "valibot";

import {
  MODEL_DOCUMENT_INPUT_OPTIONS,
  MODEL_DEFAULT_REASONING_EFFORTS,
  MODEL_REASONING_EFFORTS,
  MODEL_TEMPERATURE_POLICIES,
} from "./capabilities.gen";

/**
 * Logical model roles. Call sites declare *what* they need, not
 * *which* model to use.
 *
 * - fast: classification, extraction, short generation
 * - chat: conversational with tool use and streaming
 * - reasoning: complex multi-step legal analysis
 * - pdf: native PDF/image understanding
 */
export const MODEL_ROLES = ["fast", "chat", "reasoning", "pdf"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export const TEMPERATURE_POLICIES = ["emit", "omit"] as const;

export type TemperaturePolicy = (typeof TEMPERATURE_POLICIES)[number];

export const AI_PROVIDERS = [
  "google",
  "openrouter",
  "openai",
  "azure_foundry",
  "anthropic",
  "bedrock",
  "mistral",
  "openai_compatible",
  "huggingface",
] as const;

export type AIProvider = (typeof AI_PROVIDERS)[number];

const AI_PROVIDER_ADAPTER_KIND = {
  google: "tanstack",
  openrouter: "tanstack",
  openai: "tanstack",
  azure_foundry: "custom",
  anthropic: "tanstack",
  bedrock: "tanstack",
  mistral: "tanstack",
  openai_compatible: "custom",
  huggingface: "custom",
} as const satisfies Record<AIProvider, "custom" | "tanstack">;

export type TanStackAIProvider = {
  [TProvider in AIProvider]: (typeof AI_PROVIDER_ADAPTER_KIND)[TProvider] extends "tanstack"
    ? TProvider
    : never;
}[AIProvider];

export const TANSTACK_AI_PROVIDERS = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "bedrock",
  "mistral",
] as const satisfies readonly TanStackAIProvider[];

type MissingTanStackAIProvider = Exclude<
  TanStackAIProvider,
  (typeof TANSTACK_AI_PROVIDERS)[number]
>;

true satisfies MissingTanStackAIProvider extends never ? true : never;

export const MODEL_CATALOG_PROVIDER_KIND = {
  google: "first-party",
  openrouter: "aggregator",
  openai: "first-party",
  anthropic: "first-party",
  bedrock: "platform",
  mistral: "first-party",
} as const satisfies Record<
  TanStackAIProvider,
  "aggregator" | "first-party" | "platform"
>;

/** Providers whose picker IDs map directly to public first-party catalogs. */
export type FirstPartyModelProvider = {
  [TProvider in TanStackAIProvider]: (typeof MODEL_CATALOG_PROVIDER_KIND)[TProvider] extends "first-party"
    ? TProvider
    : never;
}[TanStackAIProvider];

const FIRST_PARTY_MODEL_PROVIDER_VALUES = [
  "google",
  "openai",
  "anthropic",
  "mistral",
] as const satisfies readonly FirstPartyModelProvider[];

/**
 * Runtime form of the first-party provider union. The conditional annotation
 * makes adding a first-party policy without adding its discovery implementation
 * a compile error.
 */
export const FIRST_PARTY_MODEL_PROVIDERS: Exclude<
  FirstPartyModelProvider,
  (typeof FIRST_PARTY_MODEL_PROVIDER_VALUES)[number]
> extends never
  ? typeof FIRST_PARTY_MODEL_PROVIDER_VALUES
  : never = FIRST_PARTY_MODEL_PROVIDER_VALUES;

/**
 * Per-role default model IDs for the BYOK-capable cloud providers.
 * Shared between the instance default table (`DEFAULT_MODELS`) and the
 * settings-UI default selection, so a default is defined exactly once.
 */
export const BYOK_DEFAULT_MODELS = {
  google: {
    fast: "gemini-3.7-flash",
    chat: "gemini-3.7-flash",
    reasoning: "gemini-3.7-flash",
    pdf: "gemini-3.7-flash",
  },
  openrouter: {
    fast: "openai/gpt-5.6-luna",
    chat: "openai/gpt-5.6-terra",
    reasoning: "openai/gpt-5.6-terra",
    pdf: "openai/gpt-5.6-terra",
  },
  openai: {
    fast: "gpt-5.4-nano",
    chat: "gpt-5.4-mini",
    reasoning: "gpt-5.4",
    pdf: "gpt-5.4",
  },
  anthropic: {
    fast: "claude-opus-5",
    chat: "claude-opus-5",
    reasoning: "claude-opus-5",
    pdf: "claude-opus-5",
  },
  bedrock: {
    fast: "us.amazon.nova-micro-v1:0",
    chat: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    reasoning: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    pdf: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
  mistral: {
    fast: "mistral-small-latest",
    chat: "mistral-medium-latest",
    reasoning: "magistral-medium-latest",
    pdf: "mistral-large-latest",
  },
} as const satisfies Record<TanStackAIProvider, Record<ModelRole, string>>;

/**
 * Instance-level default model IDs per provider. Extends the BYOK
 * defaults with the providers that only the instance path uses
 * (custom deployments and OpenAI-compatible endpoints).
 */
export const DEFAULT_MODELS = {
  ...BYOK_DEFAULT_MODELS,
  azure_foundry: {
    fast: "gpt-5.4-nano",
    chat: "gpt-5.4-mini",
    reasoning: "gpt-5.4",
    pdf: "gpt-5.4",
  },
  openai_compatible: {
    fast: "default",
    chat: "default",
    reasoning: "default",
    pdf: "default",
  },
  huggingface: {
    fast: "speakleash/Bielik-1.5B-v3.0-Instruct",
    chat: "speakleash/Bielik-11B-v2.3-Instruct",
    reasoning: "speakleash/Bielik-11B-v2.3-Instruct",
    pdf: "speakleash/Bielik-11B-v2.3-Instruct",
  },
} as const satisfies Record<AIProvider, Record<ModelRole, string>>;

/**
 * BYOK-offered model IDs per provider — the curated catalog users pick
 * from in org settings, and the server-side allowlist the API enforces.
 * The frontend list is not a security boundary; this is what the API
 * accepts.
 *
 * Limited to providers the TanStack AI integration supports for BYOK.
 * Providers without a first-class TanStack adapter path are intentionally
 * not accepted at this boundary.
 */
export const BYOK_MODEL_OPTIONS = {
  google: [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
  ],
  anthropic: [
    "claude-sonnet-5",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-5.6",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.2",
  ],
  openrouter: [
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "google/gemini-3.8-flash",
    "google/gemini-3.7-flash",
    "google/gemini-3.6-flash",
    "google/gemini-3.5-flash-lite",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-flash-lite",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.5",
    "openai/gpt-5.4-mini",
  ],
  bedrock: [
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.amazon.nova-pro-v1:0",
    "us.amazon.nova-lite-v1:0",
    "us.amazon.nova-micro-v1:0",
    "openai.gpt-oss-120b-1:0",
    "openai.gpt-oss-20b-1:0",
    "us.deepseek.r1-v1:0",
  ],
  mistral: [
    "mistral-large-latest",
    "mistral-medium-latest",
    "mistral-small-latest",
    "magistral-medium-latest",
    "magistral-small",
    "pixtral-large-latest",
  ],
} as const satisfies Record<TanStackAIProvider, readonly string[]>;

export type BYOKProvider = keyof typeof BYOK_MODEL_OPTIONS;

// Input data for the capability generator
// (packages/scripts/src/model-catalog-capabilities-gen.ts).
export { CAPABILITY_OVERRIDES } from "./capabilities-overrides";
export type { CapabilityOverride } from "./capabilities-overrides";
export { DOCUMENT_INPUT_OVERRIDES } from "./document-input-overrides";
export type { DocumentInputOverride } from "./document-input-overrides";

export type BYOKModelIdByProvider = {
  [TProvider in BYOKProvider]: (typeof BYOK_MODEL_OPTIONS)[TProvider][number];
};

export type OfferedBYOKModelId = BYOKModelIdByProvider[BYOKProvider];

export type ModelDisplayMetadata = {
  /** Human-readable product name; model names are trademarks and stay untranslated. */
  displayName: string;
  /** Brand mark to show. This may differ from the routing provider. */
  iconProvider: BYOKProvider;
};

/**
 * Presentation metadata for every offered model. Keeping this exhaustive beside
 * the allowlist prevents a newly offered model from leaking a raw provider ID
 * into user-facing pickers. OpenRouter entries deliberately carry their model
 * creator's icon while their routing provider remains available separately.
 */
export const MODEL_DISPLAY_METADATA = {
  "gemini-3.8-flash": {
    displayName: "Gemini 3.8 Flash",
    iconProvider: "google",
  },
  "gemini-3.7-flash": {
    displayName: "Gemini 3.7 Flash",
    iconProvider: "google",
  },
  "gemini-3.6-flash": {
    displayName: "Gemini 3.6 Flash",
    iconProvider: "google",
  },
  "gemini-3.5-flash-lite": {
    displayName: "Gemini 3.5 Flash Lite",
    iconProvider: "google",
  },
  "gemini-3.1-pro-preview": {
    displayName: "Gemini 3.1 Pro Preview",
    iconProvider: "google",
  },
  "gemini-3.5-flash": {
    displayName: "Gemini 3.5 Flash",
    iconProvider: "google",
  },
  "gemini-3.1-flash-lite": {
    displayName: "Gemini 3.1 Flash Lite",
    iconProvider: "google",
  },
  "claude-sonnet-5": {
    displayName: "Claude Sonnet 5",
    iconProvider: "anthropic",
  },
  "claude-fable-5-1": {
    displayName: "Claude Fable 5.1",
    iconProvider: "anthropic",
  },
  "claude-fable-5": {
    displayName: "Claude Fable 5",
    iconProvider: "anthropic",
  },
  "claude-opus-5": {
    displayName: "Claude Opus 5",
    iconProvider: "anthropic",
  },
  "claude-opus-4-8": {
    displayName: "Claude Opus 4.8",
    iconProvider: "anthropic",
  },
  "claude-opus-4-7": {
    displayName: "Claude Opus 4.7",
    iconProvider: "anthropic",
  },
  "claude-sonnet-4-6": {
    displayName: "Claude Sonnet 4.6",
    iconProvider: "anthropic",
  },
  "claude-opus-4-6": {
    displayName: "Claude Opus 4.6",
    iconProvider: "anthropic",
  },
  "claude-haiku-4-5-20251001": {
    displayName: "Claude Haiku 4.5",
    iconProvider: "anthropic",
  },
  // `gpt-5.6` is OpenAI's alias for the Sol model. Keep the API alias as the
  // canonical ID while exposing the family member's product name in pickers.
  "gpt-5.6": { displayName: "GPT-5.6 Sol", iconProvider: "openai" },
  "gpt-5.6-terra": { displayName: "GPT-5.6 Terra", iconProvider: "openai" },
  "gpt-5.6-luna": { displayName: "GPT-5.6 Luna", iconProvider: "openai" },
  "gpt-5.5": { displayName: "GPT-5.5", iconProvider: "openai" },
  "gpt-5.4": { displayName: "GPT-5.4", iconProvider: "openai" },
  "gpt-5.4-mini": {
    displayName: "GPT-5.4 Mini",
    iconProvider: "openai",
  },
  "gpt-5.4-nano": {
    displayName: "GPT-5.4 Nano",
    iconProvider: "openai",
  },
  "gpt-5.2": { displayName: "GPT-5.2", iconProvider: "openai" },
  "openai/gpt-5.6-luna": {
    displayName: "GPT-5.6 Luna",
    iconProvider: "openai",
  },
  "openai/gpt-5.6-terra": {
    displayName: "GPT-5.6 Terra",
    iconProvider: "openai",
  },
  "google/gemini-3.8-flash": {
    displayName: "Gemini 3.8 Flash",
    iconProvider: "google",
  },
  "google/gemini-3.7-flash": {
    displayName: "Gemini 3.7 Flash",
    iconProvider: "google",
  },
  "google/gemini-3.6-flash": {
    displayName: "Gemini 3.6 Flash",
    iconProvider: "google",
  },
  "google/gemini-3.5-flash-lite": {
    displayName: "Gemini 3.5 Flash Lite",
    iconProvider: "google",
  },
  "google/gemini-3.1-pro-preview": {
    displayName: "Gemini 3.1 Pro Preview",
    iconProvider: "google",
  },
  "google/gemini-3.5-flash": {
    displayName: "Gemini 3.5 Flash",
    iconProvider: "google",
  },
  "google/gemini-3.1-flash-lite": {
    displayName: "Gemini 3.1 Flash Lite",
    iconProvider: "google",
  },
  "anthropic/claude-sonnet-5": {
    displayName: "Claude Sonnet 5",
    iconProvider: "anthropic",
  },
  "anthropic/claude-opus-5": {
    displayName: "Claude Opus 5",
    iconProvider: "anthropic",
  },
  "anthropic/claude-opus-4.8": {
    displayName: "Claude Opus 4.8",
    iconProvider: "anthropic",
  },
  "anthropic/claude-sonnet-4.6": {
    displayName: "Claude Sonnet 4.6",
    iconProvider: "anthropic",
  },
  "openai/gpt-5.5": { displayName: "GPT-5.5", iconProvider: "openai" },
  "openai/gpt-5.4-mini": {
    displayName: "GPT-5.4 Mini",
    iconProvider: "openai",
  },
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    displayName: "Claude Sonnet 4.5",
    iconProvider: "anthropic",
  },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
    displayName: "Claude Haiku 4.5",
    iconProvider: "anthropic",
  },
  "us.amazon.nova-pro-v1:0": {
    displayName: "Amazon Nova Pro",
    iconProvider: "bedrock",
  },
  "us.amazon.nova-lite-v1:0": {
    displayName: "Amazon Nova Lite",
    iconProvider: "bedrock",
  },
  "us.amazon.nova-micro-v1:0": {
    displayName: "Amazon Nova Micro",
    iconProvider: "bedrock",
  },
  "openai.gpt-oss-120b-1:0": {
    displayName: "GPT OSS 120B",
    iconProvider: "openai",
  },
  "openai.gpt-oss-20b-1:0": {
    displayName: "GPT OSS 20B",
    iconProvider: "openai",
  },
  "us.deepseek.r1-v1:0": {
    displayName: "DeepSeek R1",
    iconProvider: "bedrock",
  },
  "mistral-large-latest": {
    displayName: "Mistral Large",
    iconProvider: "mistral",
  },
  "mistral-medium-latest": {
    displayName: "Mistral Medium",
    iconProvider: "mistral",
  },
  "mistral-small-latest": {
    displayName: "Mistral Small",
    iconProvider: "mistral",
  },
  "magistral-medium-latest": {
    displayName: "Magistral Medium",
    iconProvider: "mistral",
  },
  "magistral-small": {
    displayName: "Magistral Small",
    iconProvider: "mistral",
  },
  "pixtral-large-latest": {
    displayName: "Pixtral Large",
    iconProvider: "mistral",
  },
} as const satisfies Record<OfferedBYOKModelId, ModelDisplayMetadata>;

const MODEL_DISPLAY_METADATA_BY_ID: Readonly<
  Record<string, ModelDisplayMetadata>
> = MODEL_DISPLAY_METADATA;

export const getModelDisplayMetadata = (
  modelId: string,
): ModelDisplayMetadata | null =>
  MODEL_DISPLAY_METADATA_BY_ID[normalizeModelCatalogId(modelId)] ?? null;

/**
 * Offered models whose provider API accepts PDF/file content. Generated from
 * live models.dev input modalities plus dated, reviewed source corrections;
 * the nightly upstream check rejects drift.
 */
export const BYOK_DOCUMENT_INPUT_MODEL_OPTIONS = MODEL_DOCUMENT_INPUT_OPTIONS;

export const isBYOKProviderRoleSupported = ({
  provider,
  role,
}: {
  provider: BYOKProvider;
  role: ModelRole;
}): boolean =>
  role !== "pdf" || BYOK_DOCUMENT_INPUT_MODEL_OPTIONS[provider].length > 0;

export const isBYOKModelRoleSupported = ({
  provider,
  modelId,
  role,
}: {
  provider: BYOKProvider;
  modelId: string;
  role: ModelRole;
}): boolean => {
  if (role !== "pdf") {
    return true;
  }
  const supportedModels: readonly string[] =
    BYOK_DOCUMENT_INPUT_MODEL_OPTIONS[provider];
  return supportedModels.includes(modelId);
};

/**
 * Models whose provider adapter can receive a PDF `document` content part in a
 * chat turn without throwing. This is a narrower, runtime question than the
 * pdf ROLE (`BYOK_DOCUMENT_INPUT_MODEL_OPTIONS`, which curates model selection
 * for PDF-processing flows): it only asks "will the chat stream survive this
 * attachment." The Mistral text adapter maps PDF `document` parts to
 * `document_url`, so its
 * vision models accept PDF attachments even though Mistral is deliberately not
 * offered as a pdf-role provider. Mistral's `document_url` takes PDF but NOT
 * textual documents (docx/txt/csv/md), so those still gate on
 * `BYOK_DOCUMENT_INPUT_MODEL_OPTIONS` (which excludes Mistral). Superset
 * invariant: every pdf-role document model also accepts a PDF chat attachment.
 */
export const CHAT_PDF_ATTACHMENT_MODEL_OPTIONS = {
  ...BYOK_DOCUMENT_INPUT_MODEL_OPTIONS,
  mistral: [
    "mistral-medium-latest",
    "mistral-small-latest",
    "pixtral-large-latest",
  ],
} as const satisfies {
  [TProvider in BYOKProvider]: readonly BYOKModelIdByProvider[TProvider][];
};

export const isChatPdfAttachmentModelSupported = ({
  provider,
  modelId,
}: {
  provider: BYOKProvider;
  modelId: string;
}): boolean => {
  const supportedModels: readonly string[] =
    CHAT_PDF_ATTACHMENT_MODEL_OPTIONS[provider];
  return supportedModels.includes(modelId);
};

/**
 * Whether a model id is currently offered for this provider+role: it
 * must be in the curated catalog for the provider AND satisfy the
 * role's input-modality constraint (PDF needs a document-capable
 * model). This is the runtime allowlist, so a model dropped by a
 * catalog bump stops being valid here even though it is still a
 * non-empty string in a stored org config.
 */
const isOfferedBYOKModelForRole = ({
  provider,
  modelId,
  role,
}: {
  provider: BYOKProvider;
  modelId: string;
  role: ModelRole;
}): boolean => {
  const offered: readonly string[] = BYOK_MODEL_OPTIONS[provider];
  return (
    offered.includes(modelId) &&
    isBYOKModelRoleSupported({ provider, modelId, role })
  );
};

/**
 * Resolve a model id that will actually work for this provider+role,
 * keeping the SAME provider. Returns the caller's model unchanged when
 * it is still offered; otherwise falls back to the provider's per-role
 * default (`BYOK_DEFAULT_MODELS`). Returns `null` only when the
 * provider has no valid model for the role at all — the sole case
 * today is `mistral` + `pdf`, because the TanStack Mistral adapter
 * exposes no `document` input modality, so no Mistral model (not even
 * the default) can serve the PDF role.
 *
 * Used to auto-heal org AI configs whose pinned model was removed by a
 * catalog bump, so generation resolves to a supported model instead of
 * 400-ing (or forwarding a retired id to the provider).
 */
export const resolveWorkingBYOKModelForRole = ({
  provider,
  modelId,
  role,
}: {
  provider: BYOKProvider;
  modelId: string;
  role: ModelRole;
}): string | null => {
  if (isOfferedBYOKModelForRole({ provider, modelId, role })) {
    return modelId;
  }
  const fallback = BYOK_DEFAULT_MODELS[provider][role];
  return isOfferedBYOKModelForRole({ provider, modelId: fallback, role })
    ? fallback
    : null;
};

/**
 * Anthropic models that use the adaptive-thinking request shape
 * (`thinking: { type: "adaptive" }`). Newer Claude models reject the
 * legacy budget-based form, so every Opus 4.6+/Sonnet 4.6/Fable entry
 * offered above must appear here or it will 400 on the reasoning role.
 */
export const ANTHROPIC_ADAPTIVE_THINKING_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-fable-5-1",
] as const;

/**
 * Canonical reasoning-effort ladder, ordered weakest to strongest.
 * Union of every effort keyword the offered providers accept; no
 * single model accepts all of them, which is exactly why the
 * generated per-model `MODEL_REASONING_EFFORTS` exists.
 */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

const resolvedReasoningEffortSchema = v.pipe(
  v.picklist(REASONING_EFFORTS),
  v.brand("ResolvedReasoningEffort"),
);

/**
 * A reasoning effort proven to be accepted by the model it targets.
 * Only `resolveReasoningEffort` can produce this type, so option
 * builders cannot hand a provider a literal effort the model rejects
 * (e.g. `"none"` to a model whose reasoning cannot be disabled) —
 * that mistake now fails typecheck instead of 502-ing at runtime.
 */
export type ResolvedReasoningEffort = v.InferOutput<
  typeof resolvedReasoningEffortSchema
>;

// Per-model capability maps are generated from models.dev; see
// capabilities.gen.ts (regenerate with `bun --filter @stll/ai-catalog
// gen:capabilities`).
export {
  MODEL_DEFAULT_REASONING_EFFORTS,
  MODEL_REASONING_EFFORTS,
  MODEL_TEMPERATURE_POLICIES,
} from "./capabilities.gen";

type OfferedFirstPartyModelId =
  (typeof BYOK_MODEL_OPTIONS)[FirstPartyModelProvider][number];

/**
 * Providers whose catalog is served on the platform's own credentials
 * (no public first-party catalog). Their offered ids must be rated the
 * same as first-party ids: instance-key dispatch refuses unrated
 * models, so a missing rate here bricks the model, and consumption
 * accounting cannot price it either way.
 */
type PlatformModelProvider = {
  [TProvider in TanStackAIProvider]: (typeof MODEL_CATALOG_PROVIDER_KIND)[TProvider] extends "platform"
    ? TProvider
    : never;
}[TanStackAIProvider];

type OfferedPlatformModelId =
  (typeof BYOK_MODEL_OPTIONS)[PlatformModelProvider][number];

/**
 * Underlying ids of the offered aggregator models, mirroring the
 * runtime `OPENROUTER_UNDERLYING_MODEL_ID_BY_ID` strip so an offered
 * aggregator model whose underlying id is unrated fails typecheck
 * instead of failing at dispatch.
 */
type NormalizedCatalogId<TId extends string> =
  TId extends keyof typeof MODEL_CATALOG_ID_ALIASES
    ? (typeof MODEL_CATALOG_ID_ALIASES)[TId]
    : TId;

/** Derived, not hand-listed: a new aggregator joins the check by kind. */
type AggregatorModelProvider = {
  [TProvider in TanStackAIProvider]: (typeof MODEL_CATALOG_PROVIDER_KIND)[TProvider] extends "aggregator"
    ? TProvider
    : never;
}[TanStackAIProvider];

type OfferedAggregatorUnderlyingModelId =
  (typeof BYOK_MODEL_OPTIONS)[AggregatorModelProvider][number] extends infer TId extends
    string
    ? TId extends `${string}/${infer TUnderlying}`
      ? NormalizedCatalogId<TUnderlying>
      : NormalizedCatalogId<TId>
    : never;

/**
 * Provider-native IDs that are exact aliases of an offered catalog ID.
 * Every metadata lookup normalizes here, so instance/dev overrides cannot
 * bypass rates or capabilities and duplicated alias rows cannot drift apart.
 */
/**
 * Per-provider model served when a user's included budget is exhausted
 * and no explicit selection overrides it. Falls back to each
 * provider's fast-role default; providers without a first-class
 * adapter path cannot serve the lane. Total over providers so a new
 * provider lands with an explicit decision.
 */
export const FALLBACK_CHAT_MODEL_BY_PROVIDER = {
  google: DEFAULT_MODELS.google.fast,
  openrouter: "openai/gpt-5.6-luna",
  openai: "gpt-5.6-luna",
  anthropic: DEFAULT_MODELS.anthropic.fast,
  bedrock: DEFAULT_MODELS.bedrock.fast,
  mistral: DEFAULT_MODELS.mistral.fast,
  azure_foundry: null,
  openai_compatible: null,
  huggingface: null,
} as const satisfies Record<AIProvider, string | null>;

export const MODEL_CATALOG_ID_ALIASES = {
  "gpt-5.6-sol": "gpt-5.6",
  // Aggregator listings use the dotted marketing forms; the catalog's
  // canonical ids are the dashed API forms.
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
} as const satisfies Readonly<Record<string, OfferedFirstPartyModelId>>;

const MODEL_CATALOG_ID_ALIAS_TARGET_BY_ID: Readonly<Record<string, string>> =
  MODEL_CATALOG_ID_ALIASES;

export const normalizeModelCatalogId = (modelId: string): string =>
  MODEL_CATALOG_ID_ALIAS_TARGET_BY_ID[modelId] ?? modelId;

const MODEL_TEMPERATURE_POLICY_BY_ID: Readonly<
  Record<string, TemperaturePolicy>
> = MODEL_TEMPERATURE_POLICIES;

/**
 * Whether stella should emit a `temperature` override for this model.
 * This is deliberately stricter than provider acceptance: deprecated
 * parameters that are accepted but ignored resolve to `false`. Unknown ids
 * also resolve to `false` (send nothing; provider default). Callers must
 * never index `MODEL_TEMPERATURE_POLICIES` directly with
 * a runtime string.
 */
export const shouldEmitTemperature = (modelId: string): boolean =>
  MODEL_TEMPERATURE_POLICY_BY_ID[normalizeModelCatalogId(modelId)] === "emit";

const MODEL_REASONING_EFFORTS_BY_ID: Readonly<
  Record<string, readonly ReasoningEffort[] | null>
> = MODEL_REASONING_EFFORTS;

/**
 * Declared reasoning-effort values for a model ID, or `null` when the
 * model has no effort control or is not catalogued (custom deployments,
 * env overrides). Callers must never index `MODEL_REASONING_EFFORTS`
 * directly with a runtime string.
 */
export const getModelReasoningEfforts = (
  modelId: string,
): readonly ReasoningEffort[] | null =>
  MODEL_REASONING_EFFORTS_BY_ID[normalizeModelCatalogId(modelId)] ?? null;

const MODEL_DEFAULT_REASONING_EFFORTS_BY_ID: Readonly<
  Record<string, ReasoningEffort | null>
> = MODEL_DEFAULT_REASONING_EFFORTS;

/**
 * Concrete provider-default effort published for a model, or null when the
 * provider exposes no named default. Unknown ids also resolve to null.
 */
export const getModelDefaultReasoningEffort = (
  modelId: string,
): ReasoningEffort | null =>
  MODEL_DEFAULT_REASONING_EFFORTS_BY_ID[normalizeModelCatalogId(modelId)] ??
  null;

// Sole constructor of the ResolvedReasoningEffort brand; every call
// site below has already established membership in the model's
// declared effort set, and the parse revalidates it at runtime.
const asResolvedReasoningEffort = (
  effort: ReasoningEffort,
): ResolvedReasoningEffort => v.parse(resolvedReasoningEffortSchema, effort);

export type ResolveReasoningEffortOptions = {
  modelId: string;
  requested: ReasoningEffort;
};

/**
 * Clamp a requested reasoning effort into the target model's declared
 * capability.
 *
 * - Unknown model or no effort control → `null` (send no effort at
 *   all; the provider default is the only universally safe choice).
 * - Requested value supported → returned unchanged.
 * - Otherwise → the supported value nearest on `REASONING_EFFORTS`,
 *   preferring the weaker side on ties, so a "none" request against a
 *   reasoning-mandatory model degrades to its weakest tier instead of
 *   erroring, and requests above the model's ceiling clamp down to it.
 */
export const resolveReasoningEffort = ({
  modelId,
  requested,
}: ResolveReasoningEffortOptions): ResolvedReasoningEffort | null => {
  const efforts = getModelReasoningEfforts(modelId);
  const weakest = efforts?.at(0);
  if (efforts === null || weakest === undefined) {
    return null;
  }
  if (efforts.includes(requested)) {
    return asResolvedReasoningEffort(requested);
  }
  const requestedRank = REASONING_EFFORTS.indexOf(requested);
  let nearest: ReasoningEffort = weakest;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const effort of efforts) {
    const distance = Math.abs(
      REASONING_EFFORTS.indexOf(effort) - requestedRank,
    );
    if (
      distance < nearestDistance ||
      (distance === nearestDistance &&
        REASONING_EFFORTS.indexOf(effort) < REASONING_EFFORTS.indexOf(nearest))
    ) {
      nearest = effort;
      nearestDistance = distance;
    }
  }
  return asResolvedReasoningEffort(nearest);
};

/**
 * Per-model ledger rates, normalized micro-units per 1M tokens.
 *
 * Keys are the canonical model IDs stella passes to provider adapters.
 * Consumers (`apps/api/src/lib/usage/unit-model.ts`) fall back to a
 * defensive default for unknown IDs. The nightly
 * `model-catalog-upstream` check validates that every offered
 * first-party model has an entry and that entries stay mutually
 * consistent with upstream catalog cost metadata, so a stale entry
 * fails CI instead of silently mis-attributing usage.
 */
export type ModelRateAmounts = {
  /** Normalized micro-units per 1M input tokens. */
  inputPerMTok: number;
  /** Normalized micro-units per 1M output tokens. */
  outputPerMTok: number;
  /**
   * Normalized micro-units per 1M cached input tokens, when the
   * provider offers a cache-read adjustment. Falls back to
   * `inputPerMTok` when undefined.
   */
  cachedInputPerMTok?: number;
};

/**
 * A discriminated rate schedule. Consumers must resolve the schedule from the
 * request's total input tokens before reading any prices, so a model with a
 * long-context premium cannot accidentally be metered at its base rate.
 */
export type ModelRate =
  | ({ kind: "flat" } & ModelRateAmounts)
  | {
      kind: "input-token-tiered";
      /** The base tier applies at or below this total input-token count. */
      inputTokenThreshold: number;
      standard: ModelRateAmounts;
      /** Applies to the entire request once input exceeds the threshold. */
      aboveThreshold: ModelRateAmounts;
    };

export const getStandardModelRate = (rate: ModelRate): ModelRateAmounts =>
  rate.kind === "flat" ? rate : rate.standard;

export const resolveModelRate = (
  rate: ModelRate,
  inputTokens: number,
): ModelRateAmounts =>
  rate.kind === "input-token-tiered" && inputTokens > rate.inputTokenThreshold
    ? rate.aboveThreshold
    : getStandardModelRate(rate);

/**
 * Providers whose catalog entries are first-party API model IDs and so
 * must carry an explicit rate. Mirrors `MODELS_DEV_PROVIDER` in the
 * nightly check; `openrouter` (provider-prefixed slugs) and the
 * legacy/custom-deployment providers are metered by their underlying
 * model IDs or the fallback rate.
 */
// `satisfies Record<OfferedFirstPartyModelId, ...>` makes offering a
// first-party model without a rate a compile error; the intersection
// with `Record<string, ...>` keeps room for retired models that still
// appear in historical ledger rows.
export const MODEL_RATES = {
  "gemini-2.5-flash": {
    kind: "flat",
    inputPerMTok: 30_000,
    outputPerMTok: 250_000,
    cachedInputPerMTok: 7500,
  },
  "gemini-2.5-pro": {
    kind: "flat",
    inputPerMTok: 125_000,
    outputPerMTok: 1_000_000,
    cachedInputPerMTok: 31_250,
  },
  "gemini-3.1-flash-lite": {
    kind: "flat",
    inputPerMTok: 25_000,
    outputPerMTok: 150_000,
    cachedInputPerMTok: 2500,
  },
  "gemini-3.5-flash": {
    kind: "flat",
    inputPerMTok: 150_000,
    outputPerMTok: 900_000,
    cachedInputPerMTok: 15_000,
  },
  "gemini-3.5-flash-lite": {
    kind: "flat",
    inputPerMTok: 30_000,
    outputPerMTok: 250_000,
    cachedInputPerMTok: 3000,
  },
  "gemini-3.6-flash": {
    kind: "flat",
    inputPerMTok: 75_000,
    outputPerMTok: 375_000,
    cachedInputPerMTok: 7500,
  },
  "gemini-3.7-flash": {
    kind: "flat",
    inputPerMTok: 75_000,
    outputPerMTok: 375_000,
    cachedInputPerMTok: 7500,
  },
  "gemini-3.8-flash": {
    kind: "flat",
    inputPerMTok: 75_000,
    outputPerMTok: 375_000,
    cachedInputPerMTok: 7500,
  },
  "gemini-3.1-pro-preview": {
    kind: "input-token-tiered",
    inputTokenThreshold: 200_000,
    standard: {
      inputPerMTok: 200_000,
      outputPerMTok: 1_200_000,
      cachedInputPerMTok: 20_000,
    },
    aboveThreshold: {
      inputPerMTok: 400_000,
      outputPerMTok: 1_800_000,
      cachedInputPerMTok: 40_000,
    },
  },
  "gpt-4o-mini": {
    kind: "flat",
    inputPerMTok: 15_000,
    outputPerMTok: 60_000,
    cachedInputPerMTok: 7500,
  },
  "gpt-4o": {
    kind: "flat",
    inputPerMTok: 250_000,
    outputPerMTok: 1_000_000,
    cachedInputPerMTok: 125_000,
  },
  "gpt-5.2": {
    kind: "flat",
    inputPerMTok: 175_000,
    outputPerMTok: 1_400_000,
    cachedInputPerMTok: 17_500,
  },
  "gpt-5.4-nano": {
    kind: "flat",
    inputPerMTok: 20_000,
    outputPerMTok: 125_000,
    cachedInputPerMTok: 2000,
  },
  "gpt-5.4-mini": {
    kind: "flat",
    inputPerMTok: 75_000,
    outputPerMTok: 450_000,
    cachedInputPerMTok: 7500,
  },
  "gpt-5.4": {
    kind: "input-token-tiered",
    inputTokenThreshold: 272_000,
    standard: {
      inputPerMTok: 250_000,
      outputPerMTok: 1_500_000,
      cachedInputPerMTok: 25_000,
    },
    aboveThreshold: {
      inputPerMTok: 500_000,
      outputPerMTok: 2_250_000,
      cachedInputPerMTok: 50_000,
    },
  },
  "gpt-5.5": {
    kind: "input-token-tiered",
    inputTokenThreshold: 272_000,
    standard: {
      inputPerMTok: 500_000,
      outputPerMTok: 3_000_000,
      cachedInputPerMTok: 50_000,
    },
    aboveThreshold: {
      inputPerMTok: 1_000_000,
      outputPerMTok: 4_500_000,
      cachedInputPerMTok: 100_000,
    },
  },
  "gpt-5.6": {
    kind: "input-token-tiered",
    inputTokenThreshold: 272_000,
    standard: {
      inputPerMTok: 400_000,
      outputPerMTok: 2_000_000,
      cachedInputPerMTok: 40_000,
    },
    aboveThreshold: {
      // OpenAI prices the entire >272K request at 2x input and 1.5x output.
      inputPerMTok: 800_000,
      outputPerMTok: 3_000_000,
      cachedInputPerMTok: 80_000,
    },
  },
  // Luna/Terra verified against the published price list 2026-08-16
  // (Luna's 2026-07-30 price cut).
  "gpt-5.6-luna": {
    kind: "input-token-tiered",
    inputTokenThreshold: 272_000,
    standard: {
      inputPerMTok: 20_000,
      outputPerMTok: 120_000,
      cachedInputPerMTok: 2000,
    },
    aboveThreshold: {
      // OpenAI prices the entire >272K request at 2x input and 1.5x output.
      inputPerMTok: 40_000,
      outputPerMTok: 180_000,
      cachedInputPerMTok: 4000,
    },
  },
  "gpt-5.6-terra": {
    kind: "input-token-tiered",
    inputTokenThreshold: 272_000,
    standard: {
      inputPerMTok: 200_000,
      outputPerMTok: 1_200_000,
      cachedInputPerMTok: 20_000,
    },
    aboveThreshold: {
      inputPerMTok: 400_000,
      outputPerMTok: 1_800_000,
      cachedInputPerMTok: 40_000,
    },
  },
  "claude-haiku-4-5-20251001": {
    kind: "flat",
    inputPerMTok: 100_000,
    outputPerMTok: 500_000,
    cachedInputPerMTok: 10_000,
  },
  "claude-sonnet-4-6": {
    kind: "flat",
    inputPerMTok: 300_000,
    outputPerMTok: 1_500_000,
    cachedInputPerMTok: 30_000,
  },
  "claude-sonnet-5": {
    kind: "flat",
    inputPerMTok: 200_000,
    outputPerMTok: 1_000_000,
    cachedInputPerMTok: 20_000,
  },
  "claude-opus-4-6": {
    kind: "flat",
    inputPerMTok: 500_000,
    outputPerMTok: 2_500_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-opus-4-7": {
    kind: "flat",
    inputPerMTok: 500_000,
    outputPerMTok: 2_500_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-opus-4-8": {
    kind: "flat",
    inputPerMTok: 500_000,
    outputPerMTok: 2_500_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-opus-5": {
    kind: "flat",
    inputPerMTok: 500_000,
    outputPerMTok: 2_500_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-fable-5": {
    kind: "flat",
    inputPerMTok: 1_000_000,
    outputPerMTok: 5_000_000,
    cachedInputPerMTok: 100_000,
  },
  "claude-fable-5-1": {
    kind: "flat",
    inputPerMTok: 1_000_000,
    outputPerMTok: 5_000_000,
    cachedInputPerMTok: 25_000,
  },
  "mistral-small-latest": {
    kind: "flat",
    inputPerMTok: 15_000,
    outputPerMTok: 60_000,
  },
  "mistral-large-latest": {
    kind: "flat",
    inputPerMTok: 50_000,
    outputPerMTok: 150_000,
  },
  "mistral-medium-latest": {
    kind: "flat",
    inputPerMTok: 150_000,
    outputPerMTok: 750_000,
  },
  "mistral-medium-3-5": {
    kind: "flat",
    inputPerMTok: 150_000,
    outputPerMTok: 750_000,
  },
  "magistral-medium-latest": {
    kind: "flat",
    inputPerMTok: 200_000,
    outputPerMTok: 500_000,
  },
  "magistral-small": {
    kind: "flat",
    inputPerMTok: 50_000,
    outputPerMTok: 150_000,
  },
  "magistral-small-latest": {
    kind: "flat",
    inputPerMTok: 50_000,
    outputPerMTok: 150_000,
  },
  "pixtral-large-latest": {
    kind: "flat",
    inputPerMTok: 200_000,
    outputPerMTok: 600_000,
  },
  // AWS Bedrock serverless rates (verified 2026-08-16). Cached-input
  // rates are listed only where Bedrock publishes one; the rest settle
  // cache reads at the full input rate, which can only over-count.
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
    kind: "flat",
    inputPerMTok: 300_000,
    outputPerMTok: 1_500_000,
    cachedInputPerMTok: 30_000,
  },
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
    kind: "flat",
    inputPerMTok: 100_000,
    outputPerMTok: 500_000,
    cachedInputPerMTok: 10_000,
  },
  "us.amazon.nova-pro-v1:0": {
    kind: "flat",
    inputPerMTok: 80_000,
    outputPerMTok: 320_000,
  },
  "us.amazon.nova-lite-v1:0": {
    kind: "flat",
    inputPerMTok: 6000,
    outputPerMTok: 24_000,
  },
  "us.amazon.nova-micro-v1:0": {
    kind: "flat",
    inputPerMTok: 3500,
    outputPerMTok: 14_000,
  },
  "openai.gpt-oss-120b-1:0": {
    kind: "flat",
    inputPerMTok: 15_000,
    outputPerMTok: 60_000,
  },
  "openai.gpt-oss-20b-1:0": {
    kind: "flat",
    inputPerMTok: 7000,
    outputPerMTok: 30_000,
  },
  "us.deepseek.r1-v1:0": {
    kind: "flat",
    inputPerMTok: 135_000,
    outputPerMTok: 540_000,
  },
} as const satisfies Record<
  | OfferedAggregatorUnderlyingModelId
  | OfferedFirstPartyModelId
  | OfferedPlatformModelId,
  ModelRate
> &
  Record<string, ModelRate>;

const MODEL_RATES_BY_ID: Readonly<Record<string, ModelRate>> = MODEL_RATES;

const OPENROUTER_UNDERLYING_MODEL_ID_BY_ID: Readonly<Record<string, string>> =
  Object.fromEntries(
    BYOK_MODEL_OPTIONS.openrouter.map((modelId) => [
      modelId,
      modelId.slice(modelId.indexOf("/") + 1),
    ]),
  );

export const getModelRate = (modelId: string): ModelRate | undefined => {
  const normalizedModelId = normalizeModelCatalogId(modelId);
  const exactRate = MODEL_RATES_BY_ID[normalizedModelId];
  if (exactRate !== undefined) {
    return exactRate;
  }
  const underlyingModelId =
    OPENROUTER_UNDERLYING_MODEL_ID_BY_ID[normalizedModelId];
  return underlyingModelId === undefined
    ? undefined
    : MODEL_RATES_BY_ID[normalizeModelCatalogId(underlyingModelId)];
};

/**
 * Documented input context-window sizes (in tokens) per model ID.
 *
 * Keys are the canonical model IDs stella resolves for the provider
 * adapters (the same forms used in `MODEL_RATES`, `BYOK_MODEL_OPTIONS`,
 * and `DEFAULT_MODELS`, including OpenRouter provider-prefixed slugs and
 * AWS Bedrock IDs). Values are the providers' publicly documented input
 * windows; where a provider offers a larger beta window we intentionally
 * take the conservative default (e.g. Claude's standard 200K rather than
 * the 1M beta) so context budgeting never overpromises.
 *
 * Consumers must go through `getContextWindowTokens`, which falls back to
 * `DEFAULT_CONTEXT_WINDOW_TOKENS` for any unlisted ID. Unlike
 * `MODEL_RATES`, the nightly `model-catalog-upstream` check does not
 * validate this map, so an unknown model degrades to the conservative
 * default rather than failing CI.
 */
export const CONTEXT_WINDOW_TOKENS = {
  // Google Gemini: 1M-token input window across the current lineup.
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
  "gemini-3.1-flash-lite": 1_048_576,
  "gemini-3.5-flash": 1_048_576,
  "gemini-3.5-flash-lite": 1_048_576,
  "gemini-3.6-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.1-pro-preview": 1_048_576,
  // OpenAI: GPT-4o family 128K; GPT-5 varies by generation.
  "gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
  "gpt-5.2": 400_000,
  "gpt-5.4-nano": 400_000,
  "gpt-5.4-mini": 400_000,
  "gpt-5.4": 400_000,
  "gpt-5.5": 400_000,
  "gpt-5.6": 922_000,
  "gpt-5.6-luna": 922_000,
  "gpt-5.6-terra": 922_000,
  // Anthropic Claude: 200K through Claude 4; Sonnet 5, Opus 5, and Fable 5.1
  // expose 1M.
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-8": 200_000,
  "claude-opus-5": 1_000_000,
  "claude-fable-5": 200_000,
  "claude-fable-5-1": 1_000_000,
  // Mistral: 128K across the offered text/vision models.
  "mistral-small-latest": 128_000,
  "mistral-large-latest": 128_000,
  "mistral-medium-latest": 128_000,
  "mistral-medium-3-5": 128_000,
  "magistral-medium-latest": 128_000,
  "magistral-small-latest": 128_000,
  "magistral-small": 128_000,
  "pixtral-large-latest": 128_000,
  // OpenRouter provider-prefixed slugs mirror their upstream windows.
  "google/gemini-3.8-flash": 1_048_576,
  "google/gemini-3.7-flash": 1_048_576,
  "google/gemini-3.6-flash": 1_048_576,
  "google/gemini-3.5-flash-lite": 1_048_576,
  "google/gemini-3.1-pro-preview": 1_048_576,
  "google/gemini-3.5-flash": 1_048_576,
  "google/gemini-3.1-flash-lite": 1_048_576,
  "anthropic/claude-sonnet-5": 1_000_000,
  "anthropic/claude-opus-5": 1_000_000,
  "anthropic/claude-opus-4.8": 200_000,
  "anthropic/claude-sonnet-4.6": 200_000,
  "openai/gpt-5.6-luna": 922_000,
  "openai/gpt-5.6-terra": 922_000,
  "openai/gpt-5.5": 400_000,
  "openai/gpt-5.4-mini": 400_000,
  // AWS Bedrock IDs.
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": 200_000,
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": 200_000,
  "us.amazon.nova-pro-v1:0": 300_000, // Nova Pro/Lite: 300K input.
  "us.amazon.nova-lite-v1:0": 300_000,
  "us.amazon.nova-micro-v1:0": 128_000, // Nova Micro: 128K input.
  "openai.gpt-oss-120b-1:0": 128_000, // gpt-oss on Bedrock: 128K.
  "openai.gpt-oss-20b-1:0": 128_000,
  "us.deepseek.r1-v1:0": 128_000, // DeepSeek-R1: 128K.
} as const satisfies Readonly<Record<string, number>>;

type ModelRateWithoutContextWindow = Exclude<
  keyof typeof MODEL_RATES,
  keyof typeof CONTEXT_WINDOW_TOKENS
>;

true satisfies ModelRateWithoutContextWindow extends never ? true : never;

const CONTEXT_WINDOW_TOKENS_BY_ID: Readonly<Record<string, number>> =
  CONTEXT_WINDOW_TOKENS;

/**
 * Conservative window assumed for any model ID absent from
 * `CONTEXT_WINDOW_TOKENS` (custom deployments, OpenAI-compatible
 * endpoints, brand-new IDs not yet catalogued).
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/**
 * Documented input context window for a model ID, or the conservative
 * default for unlisted IDs. Callers must never index
 * `CONTEXT_WINDOW_TOKENS` directly.
 */
export const getContextWindowTokens = (modelId: string): number =>
  CONTEXT_WINDOW_TOKENS_BY_ID[normalizeModelCatalogId(modelId)] ??
  DEFAULT_CONTEXT_WINDOW_TOKENS;
