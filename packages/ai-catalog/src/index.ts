/**
 * Canonical AI provider and model catalog.
 *
 * Single source of truth for every provider/model identifier stella
 * offers. Imported by the API runtime (`apps/api/src/lib/ai-models.ts`)
 * and the BYOK settings UI (`apps/web`), so the picker can never offer
 * a model the backend rejects, and vice versa.
 *
 * Pure data: no provider SDKs, no env access, no side effects. This is
 * deliberate so scripts (the nightly upstream-validation check) and
 * both apps can import it cheaply. Keep it that way.
 *
 * Model IDs go stale when providers rename or retire models. The
 * nightly `model-catalog-upstream` check
 * (`packages/scripts/src/model-catalog-upstream.ts`) validates every
 * ID here against live provider/aggregator listings so a retired model
 * fails CI instead of 400-ing a user at runtime.
 */

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
  "mistral",
  "openai_compatible",
  "huggingface",
] as const;

export type AIProvider = (typeof AI_PROVIDERS)[number];

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
  mistral: {
    fast: "mistral-small-latest",
    chat: "mistral-large-latest",
    reasoning: "magistral-medium-latest",
    pdf: "mistral-large-latest",
  },
} as const satisfies Partial<Record<AIProvider, Record<ModelRole, string>>>;

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
 * Limited to providers BYOK supports (no openai_compatible).
 * `azure_foundry` and `huggingface` take custom deployment IDs, so they
 * carry no curated list.
 */
export const BYOK_MODEL_OPTIONS = {
  google: [
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
  ],
  anthropic: [
    "claude-fable-5",
    "claude-opus-4-8",
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
  ],
  openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"],
  azure_foundry: [],
  huggingface: [],
  openrouter: [
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.5-flash",
    "google/gemini-3.1-flash-lite",
    "anthropic/claude-opus-4.8",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.5",
    "openai/gpt-5.4-mini",
  ],
} as const satisfies Record<
  Exclude<AIProvider, "openai_compatible">,
  readonly string[]
>;

export type BYOKProvider = keyof typeof BYOK_MODEL_OPTIONS;

/**
 * Anthropic models that use the adaptive-thinking request shape
 * (`thinking: { type: "adaptive" }`). Newer Claude models reject the
 * legacy budget-based form, so every Opus 4.6+/Sonnet 4.6/Fable entry
 * offered above must appear here or it will 400 on the reasoning role.
 */
export const ANTHROPIC_ADAPTIVE_THINKING_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
] as const;

/**
 * Anthropic models that reject sampling overrides (`temperature`,
 * `topP`, `topK`) with a 400 on every request shape; they always run
 * with provider-side defaults. Enforced by a strip middleware in the
 * model wrapper (`withInstrumentation` in
 * `apps/api/src/lib/ai-models.ts`) so neither role defaults nor
 * call-site overrides can reach the provider.
 */
export const ANTHROPIC_FIXED_SAMPLING_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
] as const;

/**
 * Per-model ledger rates, normalized micro-units per 1M tokens.
 *
 * Keys are the canonical model IDs stella passes to the AI SDK.
 * Consumers (`apps/api/src/lib/usage/unit-model.ts`) fall back to a
 * defensive default for unknown IDs. The nightly
 * `model-catalog-upstream` check validates that every offered
 * first-party model has an entry and that entries stay mutually
 * consistent with upstream catalog cost metadata, so a stale entry
 * fails CI instead of silently mis-attributing usage.
 */
export type ModelRate = {
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
 * Providers whose catalog entries are first-party API model IDs and so
 * must carry an explicit rate. Mirrors `MODELS_DEV_PROVIDER` in the
 * nightly check; `openrouter` (provider-prefixed slugs) and the
 * custom-deployment providers are metered by their underlying model
 * IDs or the fallback rate.
 */
type FirstPartyProvider = "google" | "openai" | "anthropic" | "mistral";

type OfferedFirstPartyModelId =
  (typeof BYOK_MODEL_OPTIONS)[FirstPartyProvider][number];

// `satisfies Record<OfferedFirstPartyModelId, ...>` makes offering a
// first-party model without a rate a compile error; the intersection
// with `Record<string, ...>` keeps room for retired models that still
// appear in historical ledger rows.
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  "gemini-2.5-flash": {
    inputPerMTok: 30_000,
    outputPerMTok: 250_000,
    cachedInputPerMTok: 7500,
  },
  "gemini-2.5-pro": {
    inputPerMTok: 125_000,
    outputPerMTok: 1_000_000,
    cachedInputPerMTok: 31_250,
  },
  "gemini-3.1-flash-lite": {
    inputPerMTok: 25_000,
    outputPerMTok: 150_000,
    cachedInputPerMTok: 2500,
  },
  "gemini-3.5-flash": {
    inputPerMTok: 150_000,
    outputPerMTok: 900_000,
    cachedInputPerMTok: 15_000,
  },
  "gemini-3.1-pro-preview": {
    inputPerMTok: 200_000,
    outputPerMTok: 1_200_000,
    cachedInputPerMTok: 20_000,
  },
  "gpt-4o-mini": {
    inputPerMTok: 15_000,
    outputPerMTok: 60_000,
    cachedInputPerMTok: 7500,
  },
  "gpt-4o": {
    inputPerMTok: 250_000,
    outputPerMTok: 1_000_000,
    cachedInputPerMTok: 125_000,
  },
  "gpt-5.2": {
    inputPerMTok: 175_000,
    outputPerMTok: 1_400_000,
    cachedInputPerMTok: 17_500,
  },
  "gpt-5.4-nano": {
    inputPerMTok: 20_000,
    outputPerMTok: 125_000,
    cachedInputPerMTok: 2000,
  },
  "gpt-5.4-mini": {
    inputPerMTok: 75_000,
    outputPerMTok: 450_000,
    cachedInputPerMTok: 7500,
  },
  "gpt-5.4": {
    inputPerMTok: 250_000,
    outputPerMTok: 1_500_000,
    cachedInputPerMTok: 25_000,
  },
  "gpt-5.5": {
    inputPerMTok: 500_000,
    outputPerMTok: 3_000_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-haiku-4-5-20251001": {
    inputPerMTok: 100_000,
    outputPerMTok: 500_000,
    cachedInputPerMTok: 10_000,
  },
  "claude-sonnet-4-6": {
    inputPerMTok: 300_000,
    outputPerMTok: 1_500_000,
    cachedInputPerMTok: 30_000,
  },
  "claude-opus-4-6": {
    inputPerMTok: 500_000,
    outputPerMTok: 2_500_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-opus-4-7": {
    inputPerMTok: 500_000,
    outputPerMTok: 2_500_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-opus-4-8": {
    inputPerMTok: 500_000,
    outputPerMTok: 2_500_000,
    cachedInputPerMTok: 50_000,
  },
  "claude-fable-5": {
    inputPerMTok: 1_000_000,
    outputPerMTok: 5_000_000,
    cachedInputPerMTok: 100_000,
  },
  "mistral-small-latest": {
    inputPerMTok: 15_000,
    outputPerMTok: 60_000,
  },
  "mistral-large-latest": {
    inputPerMTok: 50_000,
    outputPerMTok: 150_000,
  },
  "mistral-medium-3-5": {
    inputPerMTok: 150_000,
    outputPerMTok: 750_000,
  },
  "magistral-medium-latest": {
    inputPerMTok: 200_000,
    outputPerMTok: 500_000,
  },
} satisfies Record<OfferedFirstPartyModelId, ModelRate> &
  Record<string, ModelRate>;
