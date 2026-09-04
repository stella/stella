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
} as const satisfies Readonly<Record<string, ModelRateSource>>;

/**
 * Exact mappings where Stella uses a provider routing ID while models.dev
 * publishes pricing under the corresponding base model ID. Generation rejects
 * a mapping once models.dev begins publishing the Stella ID directly.
 */
export const MODELS_DEV_RATE_SOURCE_ALIASES = defineRateSourceAliases({
  "us.amazon.nova-pro-v1:0": {
    modelId: "amazon.nova-pro-v1:0",
    provider: "amazon-bedrock",
    reason:
      "2026-09-03: stella uses the Bedrock US inference-profile ID; " +
      "models.dev prices its corresponding base model ID",
    sourceUrl:
      "https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html",
  },
  "us.amazon.nova-lite-v1:0": {
    modelId: "amazon.nova-lite-v1:0",
    provider: "amazon-bedrock",
    reason:
      "2026-09-03: stella uses the Bedrock US inference-profile ID; " +
      "models.dev prices its corresponding base model ID",
    sourceUrl:
      "https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html",
  },
  "us.amazon.nova-micro-v1:0": {
    modelId: "amazon.nova-micro-v1:0",
    provider: "amazon-bedrock",
    reason:
      "2026-09-03: stella uses the Bedrock US inference-profile ID; " +
      "models.dev prices its corresponding base model ID",
    sourceUrl:
      "https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html",
  },
});
