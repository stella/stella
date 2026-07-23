import type { AnthropicModelInputModalitiesByName } from "@tanstack/ai-anthropic";
import type { BedrockModelInputModalitiesByName } from "@tanstack/ai-bedrock";
import type { GeminiModelInputModalitiesByName } from "@tanstack/ai-gemini";
import type { OpenRouterModelInputModalitiesByName } from "@tanstack/ai-openrouter";
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
  MODEL_REASONING_EFFORTS,
  MODEL_TEMPERATURE_SUPPORT,
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

export const TANSTACK_AI_PROVIDERS = [
  "google",
  "openrouter",
  "openai",
  "anthropic",
  "bedrock",
  "mistral",
] as const satisfies readonly AIProvider[];

export type TanStackAIProvider = (typeof TANSTACK_AI_PROVIDERS)[number];

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
    fast: "gemini-3.1-flash-lite",
    chat: "gemini-3.5-flash",
    reasoning: "gemini-3.1-pro-preview",
    pdf: "gemini-3.5-flash",
  },
  openrouter: {
    fast: "google/gemini-3.1-flash-lite",
    chat: "google/gemini-3.5-flash",
    reasoning: "google/gemini-3.1-pro-preview",
    pdf: "google/gemini-3.5-flash",
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
  bedrock: {
    fast: "us.amazon.nova-micro-v1:0",
    chat: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    reasoning: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    pdf: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
  mistral: {
    fast: "mistral-small-latest",
    chat: "mistral-large-latest",
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
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
  ],
  anthropic: [
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ],
  openai: [
    "gpt-5.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.2",
  ],
  openrouter: [
    "google/gemini-3.6-flash",
    "google/gemini-3.5-flash-lite",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-flash-lite",
    "anthropic/claude-sonnet-5",
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

type ModelInputModalitiesByName = Record<string, readonly string[]>;

type ModelWithInputModality<
  TModels extends ModelInputModalitiesByName,
  TModality extends string,
> = Extract<
  {
    [TModel in keyof TModels]: TModality extends TModels[TModel][number]
      ? TModel
      : never;
  }[keyof TModels],
  string
>;

type TanStackDocumentInputModelByProvider = {
  anthropic: ModelWithInputModality<
    AnthropicModelInputModalitiesByName,
    "document"
  >;
  bedrock: ModelWithInputModality<
    BedrockModelInputModalitiesByName,
    "document"
  >;
  google: ModelWithInputModality<GeminiModelInputModalitiesByName, "document">;
  openrouter: ModelWithInputModality<
    OpenRouterModelInputModalitiesByName,
    "document"
  >;
};

type BYOKModelIdByProvider = {
  [TProvider in BYOKProvider]: (typeof BYOK_MODEL_OPTIONS)[TProvider][number];
};

export type OfferedBYOKModelId = BYOKModelIdByProvider[BYOKProvider];

const TANSTACK_DOCUMENT_INPUT_MODEL_OPTIONS = {
  anthropic: ["claude-sonnet-5", "claude-sonnet-4-6"],
  bedrock: [
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "us.amazon.nova-pro-v1:0",
    "us.amazon.nova-lite-v1:0",
  ],
  google: [
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
  ],
  openrouter: [
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-flash-lite",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.5",
    "openai/gpt-5.4-mini",
  ],
} as const satisfies {
  [TProvider in keyof TanStackDocumentInputModelByProvider]: readonly Extract<
    BYOKModelIdByProvider[TProvider],
    TanStackDocumentInputModelByProvider[TProvider]
  >[];
};

const STELLA_EXTENDED_DOCUMENT_INPUT_MODEL_OPTIONS = {
  anthropic: [
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-haiku-4-5-20251001",
  ],
  google: ["gemini-3.6-flash", "gemini-3.5-flash-lite"],
  openai: [
    "gpt-5.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.2",
  ],
  openrouter: ["google/gemini-3.6-flash", "google/gemini-3.5-flash-lite"],
} as const satisfies Partial<{
  [TProvider in BYOKProvider]: readonly BYOKModelIdByProvider[TProvider][];
}>;

export const BYOK_DOCUMENT_INPUT_MODEL_OPTIONS = {
  anthropic: [
    ...TANSTACK_DOCUMENT_INPUT_MODEL_OPTIONS.anthropic,
    ...STELLA_EXTENDED_DOCUMENT_INPUT_MODEL_OPTIONS.anthropic,
  ],
  bedrock: TANSTACK_DOCUMENT_INPUT_MODEL_OPTIONS.bedrock,
  google: [
    ...TANSTACK_DOCUMENT_INPUT_MODEL_OPTIONS.google,
    ...STELLA_EXTENDED_DOCUMENT_INPUT_MODEL_OPTIONS.google,
  ],
  mistral: [],
  openai: STELLA_EXTENDED_DOCUMENT_INPUT_MODEL_OPTIONS.openai,
  openrouter: [
    ...TANSTACK_DOCUMENT_INPUT_MODEL_OPTIONS.openrouter,
    ...STELLA_EXTENDED_DOCUMENT_INPUT_MODEL_OPTIONS.openrouter,
  ],
} as const satisfies {
  [TProvider in BYOKProvider]: readonly BYOKModelIdByProvider[TProvider][];
};

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
 * `document_url` (patched in via the upstream document-input change), so its
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
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
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
  MODEL_REASONING_EFFORTS,
  MODEL_TEMPERATURE_SUPPORT,
} from "./capabilities.gen";

type OfferedFirstPartyModelId =
  (typeof BYOK_MODEL_OPTIONS)[FirstPartyModelProvider][number];

/**
 * Provider-native IDs that are exact aliases of an offered catalog ID.
 * Every metadata lookup normalizes here, so instance/dev overrides cannot
 * bypass rates or capabilities and duplicated alias rows cannot drift apart.
 */
export const MODEL_CATALOG_ID_ALIASES = {
  "gpt-5.6-sol": "gpt-5.6",
} as const satisfies Readonly<Record<string, OfferedFirstPartyModelId>>;

const MODEL_CATALOG_ID_ALIAS_TARGET_BY_ID: Readonly<Record<string, string>> =
  MODEL_CATALOG_ID_ALIASES;

export const normalizeModelCatalogId = (modelId: string): string =>
  MODEL_CATALOG_ID_ALIAS_TARGET_BY_ID[modelId] ?? modelId;

const MODEL_TEMPERATURE_SUPPORT_BY_ID: Readonly<Record<string, boolean>> =
  MODEL_TEMPERATURE_SUPPORT;

/**
 * Whether a `temperature` override may be sent to this model.
 * Unknown ids resolve to `false` (send nothing; provider default).
 * Callers must never index `MODEL_TEMPERATURE_SUPPORT` directly with
 * a runtime string.
 */
export const supportsTemperature = (modelId: string): boolean =>
  MODEL_TEMPERATURE_SUPPORT_BY_ID[normalizeModelCatalogId(modelId)] ?? false;

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
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
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
    inputPerMTok: 150_000,
    outputPerMTok: 750_000,
    cachedInputPerMTok: 15_000,
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
      inputPerMTok: 500_000,
      outputPerMTok: 3_000_000,
      cachedInputPerMTok: 50_000,
    },
    aboveThreshold: {
      // OpenAI prices the entire >272K request at 2x input and 1.5x output.
      inputPerMTok: 1_000_000,
      outputPerMTok: 4_500_000,
      cachedInputPerMTok: 100_000,
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
  "claude-fable-5": {
    kind: "flat",
    inputPerMTok: 1_000_000,
    outputPerMTok: 5_000_000,
    cachedInputPerMTok: 100_000,
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
} satisfies Record<OfferedFirstPartyModelId, ModelRate> &
  Record<string, ModelRate>;

export const getModelRate = (modelId: string): ModelRate | undefined =>
  MODEL_RATES[normalizeModelCatalogId(modelId)];

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
export const CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = {
  // Google Gemini: 1M-token input window across the current lineup.
  "gemini-2.5-flash": 1_048_576,
  "gemini-2.5-pro": 1_048_576,
  "gemini-3.1-flash-lite": 1_048_576,
  "gemini-3.5-flash": 1_048_576,
  "gemini-3.5-flash-lite": 1_048_576,
  "gemini-3.6-flash": 1_048_576,
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
  // Anthropic Claude: 200K through Claude 4; Sonnet 5 exposes 1M.
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-8": 200_000,
  "claude-fable-5": 200_000,
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
  "google/gemini-3.6-flash": 1_048_576,
  "google/gemini-3.5-flash-lite": 1_048_576,
  "google/gemini-3.1-pro-preview": 1_048_576,
  "google/gemini-3.5-flash": 1_048_576,
  "google/gemini-3.1-flash-lite": 1_048_576,
  "anthropic/claude-sonnet-5": 1_000_000,
  "anthropic/claude-opus-4.8": 200_000,
  "anthropic/claude-sonnet-4.6": 200_000,
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
};

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
  CONTEXT_WINDOW_TOKENS[normalizeModelCatalogId(modelId)] ??
  DEFAULT_CONTEXT_WINDOW_TOKENS;
