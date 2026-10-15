import type { BYOKProvider, OfferedBYOKModelId } from "./index";

export const MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER = {
  google: "google",
  openai: "openai",
  anthropic: "anthropic",
  bedrock: "amazon-bedrock",
  mistral: "mistral",
} as const satisfies Record<Exclude<BYOKProvider, "openrouter">, string>;

export type ModelsDevRateProvider =
  (typeof MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER)[keyof typeof MODELS_DEV_RATE_PROVIDER_BY_CATALOG_PROVIDER];

type ModelRateSource = {
  modelId: string;
  provider: ModelsDevRateProvider;
};

type ReviewedModelRateSource = ModelRateSource & {
  /** Why Stella's runtime ID does not equal the models.dev source ID. Dated. */
  reason: string;
  sourceUrl: string;
};

const defineRateSourceAliases = <
  const TAliases extends Readonly<Record<string, ReviewedModelRateSource>>,
>(
  aliases: TAliases &
    Record<Exclude<keyof TAliases, OfferedBYOKModelId>, never>,
): TAliases => aliases;

/**
 * Explicit source coordinates for non-offered model IDs that remain valid in
 * deployment overrides and usage attribution. Their numeric rates still come
 * exclusively from models.dev.
 */
export const RETAINED_MODELS_DEV_RATE_ENTRIES = {
  "gemini-2.5-flash": {
    modelId: "gemini-2.5-flash",
    provider: "google",
  },
  "gemini-2.5-pro": {
    modelId: "gemini-2.5-pro",
    provider: "google",
  },
  "gpt-4o-mini": {
    modelId: "gpt-4o-mini",
    provider: "openai",
  },
  "gpt-4o": {
    modelId: "gpt-4o",
    provider: "openai",
  },
  "us.deepseek.r1-v1:0": {
    modelId: "us.deepseek.r1-v1:0",
    provider: "amazon-bedrock",
  },
} as const satisfies Readonly<Record<string, ModelRateSource>>;

/**
 * Exact mappings where Stella uses a provider routing ID while models.dev
 * publishes pricing under the corresponding base model ID. Generation rejects
 * a mapping once models.dev begins publishing the Stella ID directly, so the
 * map is empty whenever upstream covers every offered ID.
 */
export const MODELS_DEV_RATE_SOURCE_ALIASES = defineRateSourceAliases({});

type ModelsDevCostField = "cache_read" | "cache_write" | "input" | "output";

type ReviewedModelRateCorrection = {
  field: ModelsDevCostField;
  /** The exact upstream USD value being corrected; any other value fails. */
  upstreamUsd: number;
  /** The provider-published USD price per million tokens. */
  correctedUsd: number;
  /** Why the upstream value is wrong. Dated. */
  reason: string;
  sourceUrl: string;
};

/**
 * Reviewed corrections where models.dev disagrees with the provider's own
 * published price, keyed by `<models.dev provider>:<models.dev model ID>`.
 * Each entry pins the exact upstream value it replaces, so generation fails
 * once models.dev changes that value (fixed or changed again) and the entry
 * must be deleted or re-reviewed. Generation also rejects an entry whose
 * source no rated model uses.
 */
export const MODELS_DEV_RATE_CORRECTIONS: Readonly<
  Record<string, readonly ReviewedModelRateCorrection[]>
> = {
  "anthropic:claude-sonnet-5-5": [
    {
      field: "cache_read",
      upstreamUsd: 0.1,
      correctedUsd: 0.2,
      reason: "2026-10-07: models.dev lists half the provider cache-read price",
      sourceUrl:
        "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
    },
  ],
};
