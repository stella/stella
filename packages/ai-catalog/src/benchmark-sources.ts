/**
 * Hand-reviewed mapping from every offered model to the exact Text Arena
 * (LMArena) leaderboard rows that measured it.
 *
 * Map only exact model identity. LMArena names are API-style ids with an
 * optional effort suffix: `claude-opus-5-high` is Claude Opus 5 at `high`,
 * and a name without a suffix was measured at the provider's default effort
 * (`reasoningEffort: null`). An empty array is an explicit "no measured
 * variant", never a gap to fill with a sibling, a preview, or a floating
 * alias.
 *
 * `benchmarks.gen.ts` holds the ratings for every source id referenced here;
 * regenerate it with `bun --filter @stll/ai-catalog gen:benchmarks`.
 */
import type {
  MODEL_DEFAULT_REASONING_EFFORTS,
  MODEL_REASONING_EFFORTS,
} from "./capabilities.gen";
import type { OfferedBYOKModelId } from "./index";

export const MODEL_BENCHMARK_NAME = "Text Arena";
export const MODEL_BENCHMARK_LICENCE = "CC BY 4.0";
export const MODEL_BENCHMARK_DATASET = "lmarena-ai/leaderboard-dataset";
export const MODEL_BENCHMARK_SOURCE_URL = `https://huggingface.co/datasets/${MODEL_BENCHMARK_DATASET}`;
/** Style-controlled ratings discount formatting and length preferences. */
export const MODEL_BENCHMARK_CONFIG = "text_style_control";
export const MODEL_BENCHMARK_SPLIT = "latest";
export const MODEL_BENCHMARK_CATEGORY = "overall";

type ModelEfforts<TModelId extends OfferedBYOKModelId> =
  (typeof MODEL_REASONING_EFFORTS)[TModelId] extends readonly (infer TEffort)[]
    ? TEffort
    : never;

/**
 * A suffix-less row was measured at the provider's own default. A route that
 * publishes a concrete named default (OpenRouter) sends that named effort for
 * "default", which is not what the row measured, so such routes cannot map a
 * `null` effort.
 */
type ProviderDefaultEffort<TModelId extends OfferedBYOKModelId> =
  (typeof MODEL_DEFAULT_REASONING_EFFORTS)[TModelId] extends null
    ? null
    : never;

type ModelBenchmarkSource<TModelId extends OfferedBYOKModelId> = {
  sourceModelId: string;
  reasoningEffort: ModelEfforts<TModelId> | ProviderDefaultEffort<TModelId>;
};

type ModelBenchmarkSourceMap = {
  readonly [
    TModelId in OfferedBYOKModelId
  ]: readonly ModelBenchmarkSource<TModelId>[];
};

export const MODEL_BENCHMARK_SOURCES = {
  "anthropic/claude-haiku-5.5": [],
  "us.anthropic.claude-haiku-5-5": [],
  "claude-haiku-5-5": [],
  "gemini-3.8-flash": [
    { sourceModelId: "gemini-3.8-flash-high", reasoningEffort: "high" },
  ],
  "gemini-3.7-flash": [
    { sourceModelId: "gemini-3.7-flash-high", reasoningEffort: "high" },
  ],
  "gemini-3.6-flash": [
    { sourceModelId: "gemini-3.6-flash-high", reasoningEffort: "high" },
  ],
  "gemini-3.5-flash-lite": [
    { sourceModelId: "gemini-3.5-flash-lite", reasoningEffort: null },
  ],
  "gemini-3.1-pro-preview": [
    { sourceModelId: "gemini-3.1-pro-preview", reasoningEffort: null },
  ],
  "gemini-3.5-flash": [
    { sourceModelId: "gemini-3.5-flash-medium", reasoningEffort: "medium" },
    { sourceModelId: "gemini-3.5-flash-high", reasoningEffort: "high" },
  ],
  // Only the preview snapshot is ranked; the offered GA release may differ.
  "gemini-3.1-flash-lite": [],
  "openai/gpt-6.1-sol": [],
  "openai/gpt-6-astra": [
    { sourceModelId: "gpt-6-astra-max", reasoningEffort: "max" },
  ],
  "openai/gpt-6-sol": [
    { sourceModelId: "gpt-6-sol-max", reasoningEffort: "max" },
  ],
  "openai/gpt-6-luna": [
    { sourceModelId: "gpt-6-luna-max", reasoningEffort: "max" },
  ],
  "openai/gpt-5.6-sol": [
    { sourceModelId: "gpt-5.6-sol-xhigh", reasoningEffort: "xhigh" },
  ],
  "openai/gpt-5.6-terra": [
    { sourceModelId: "gpt-5.6-terra-xhigh", reasoningEffort: "xhigh" },
  ],
  "openai/gpt-5.6-luna": [
    { sourceModelId: "gpt-5.6-luna-xhigh", reasoningEffort: "xhigh" },
  ],
  "google/gemini-3.8-flash": [
    { sourceModelId: "gemini-3.8-flash-high", reasoningEffort: "high" },
  ],
  "google/gemini-3.7-flash": [
    { sourceModelId: "gemini-3.7-flash-high", reasoningEffort: "high" },
  ],
  "google/gemini-3.6-flash": [
    { sourceModelId: "gemini-3.6-flash-high", reasoningEffort: "high" },
  ],
  // Suffix-less rows cannot map to a route whose default is a named effort.
  "google/gemini-3.5-flash-lite": [],
  "google/gemini-3.1-pro-preview": [],
  "google/gemini-3.5-flash": [
    { sourceModelId: "gemini-3.5-flash-medium", reasoningEffort: "medium" },
    { sourceModelId: "gemini-3.5-flash-high", reasoningEffort: "high" },
  ],
  "google/gemini-3.1-flash-lite": [],
  "anthropic/claude-sonnet-5.5": [],
  "anthropic/claude-sonnet-5": [
    { sourceModelId: "claude-sonnet-5-high", reasoningEffort: "high" },
  ],
  "anthropic/claude-opus-5": [
    { sourceModelId: "claude-opus-5-high", reasoningEffort: "high" },
    { sourceModelId: "claude-opus-5-max", reasoningEffort: "max" },
  ],
  "anthropic/claude-opus-4.8": [
    { sourceModelId: "claude-opus-4-8-high", reasoningEffort: "high" },
  ],
  // Only a suffix-less row exists; this route's default is a named effort.
  "anthropic/claude-sonnet-4.6": [],
  "openai/gpt-5.5": [
    { sourceModelId: "gpt-5.5-high", reasoningEffort: "high" },
  ],
  "openai/gpt-5.4-mini": [
    { sourceModelId: "gpt-5.4-mini-high", reasoningEffort: "high" },
  ],
  "gpt-6.1-sol": [],
  "gpt-6-astra": [{ sourceModelId: "gpt-6-astra-max", reasoningEffort: "max" }],
  "gpt-6-sol": [{ sourceModelId: "gpt-6-sol-max", reasoningEffort: "max" }],
  "gpt-6-luna": [{ sourceModelId: "gpt-6-luna-max", reasoningEffort: "max" }],
  // OpenAI serves GPT-5.6 Sol under the bare `gpt-5.6` alias.
  "gpt-5.6": [{ sourceModelId: "gpt-5.6-sol-xhigh", reasoningEffort: "xhigh" }],
  "gpt-5.6-terra": [
    { sourceModelId: "gpt-5.6-terra-xhigh", reasoningEffort: "xhigh" },
  ],
  "gpt-5.6-luna": [
    { sourceModelId: "gpt-5.6-luna-xhigh", reasoningEffort: "xhigh" },
  ],
  "gpt-5.5": [
    { sourceModelId: "gpt-5.5", reasoningEffort: null },
    { sourceModelId: "gpt-5.5-high", reasoningEffort: "high" },
  ],
  "gpt-5.4": [
    { sourceModelId: "gpt-5.4", reasoningEffort: null },
    { sourceModelId: "gpt-5.4-high", reasoningEffort: "high" },
  ],
  "gpt-5.4-mini": [
    { sourceModelId: "gpt-5.4-mini-high", reasoningEffort: "high" },
  ],
  "gpt-5.4-nano": [
    { sourceModelId: "gpt-5.4-nano-high", reasoningEffort: "high" },
  ],
  "gpt-5.2": [
    { sourceModelId: "gpt-5.2", reasoningEffort: null },
    { sourceModelId: "gpt-5.2-high", reasoningEffort: "high" },
  ],
  "claude-sonnet-5-5": [],
  "claude-sonnet-5": [
    { sourceModelId: "claude-sonnet-5-high", reasoningEffort: "high" },
  ],
  "claude-fable-5-1": [
    { sourceModelId: "claude-fable-5.1-max", reasoningEffort: "max" },
  ],
  "claude-fable-5": [
    { sourceModelId: "claude-fable-5-high", reasoningEffort: "high" },
  ],
  // Arena ranks `claude-opus-5.5-high` with a dotted version.
  "claude-opus-5-5": [
    { sourceModelId: "claude-opus-5.5-high", reasoningEffort: "high" },
  ],
  "claude-opus-5": [
    { sourceModelId: "claude-opus-5-high", reasoningEffort: "high" },
    { sourceModelId: "claude-opus-5-max", reasoningEffort: "max" },
  ],
  "claude-opus-4-8": [
    { sourceModelId: "claude-opus-4-8", reasoningEffort: null },
    { sourceModelId: "claude-opus-4-8-high", reasoningEffort: "high" },
  ],
  "claude-opus-4-7": [
    { sourceModelId: "claude-opus-4-7", reasoningEffort: null },
    { sourceModelId: "claude-opus-4-7-high", reasoningEffort: "high" },
  ],
  "claude-sonnet-4-6": [
    { sourceModelId: "claude-sonnet-4-6", reasoningEffort: null },
  ],
  "claude-opus-4-6": [
    { sourceModelId: "claude-opus-4-6", reasoningEffort: null },
    { sourceModelId: "claude-opus-4-6-high", reasoningEffort: "high" },
  ],
  "claude-haiku-4-5-20251001": [
    { sourceModelId: "claude-haiku-4-5-20251001", reasoningEffort: null },
  ],
  // The `-high-32k` row is a thinking budget this route does not expose.
  "us.anthropic.claude-sonnet-4-5-20250929-v1:0": [
    { sourceModelId: "claude-sonnet-4-5-20250929", reasoningEffort: null },
  ],
  "us.anthropic.claude-haiku-4-5-20251001-v1:0": [
    { sourceModelId: "claude-haiku-4-5-20251001", reasoningEffort: null },
  ],
  "us.amazon.nova-pro-v1:0": [
    { sourceModelId: "amazon-nova-pro-v1.0", reasoningEffort: null },
  ],
  "us.amazon.nova-lite-v1:0": [
    { sourceModelId: "amazon-nova-lite-v1.0", reasoningEffort: null },
  ],
  "us.amazon.nova-micro-v1:0": [
    { sourceModelId: "amazon-nova-micro-v1.0", reasoningEffort: null },
  ],
  "openai.gpt-oss-120b-1:0": [
    { sourceModelId: "gpt-oss-120b", reasoningEffort: null },
  ],
  "openai.gpt-oss-20b-1:0": [
    { sourceModelId: "gpt-oss-20b", reasoningEffort: null },
  ],
  "mistral-large-4": [],
  // `-latest` aliases move between pinned releases; Arena ranks pinned ones.
  "mistral-large-latest": [],
  "mistral-medium-latest": [],
  "mistral-small-latest": [],
} as const satisfies ModelBenchmarkSourceMap;

export const MODEL_UNRATED_REASONS = [
  /** Released after the snapshot; Arena has not ranked it yet. */
  "too_new",
  /** Arena ranks only a preview snapshot, which may differ from the release. */
  "preview_only",
  /** Only a suffix-less row exists and this route's default is a named effort. */
  "named_default_effort",
  /** A `-latest` alias that moves between the pinned releases Arena ranks. */
  "floating_alias",
] as const;

export type ModelUnratedReason = (typeof MODEL_UNRATED_REASONS)[number];

/** Offered models whose source list above is empty. */
export type UnratedOfferedModelId = {
  [
    TModelId in OfferedBYOKModelId
  ]: (typeof MODEL_BENCHMARK_SOURCES)[TModelId] extends readonly []
    ? TModelId
    : never;
}[OfferedBYOKModelId];

/**
 * A reviewed reason for every offered model without an exact Text Arena row.
 * A newly offered unrated model fails typecheck until it has one, and mapping
 * a source later makes its entry here an excess key, so the lists cannot
 * drift. `too_new` drives the picker's "New" recommendation.
 */
export const MODEL_UNRATED_REASON = {
  "anthropic/claude-haiku-5.5": "too_new",
  "us.anthropic.claude-haiku-5-5": "too_new",
  "claude-haiku-5-5": "too_new",
  "gemini-3.1-flash-lite": "preview_only",
  "openai/gpt-6.1-sol": "too_new",
  "google/gemini-3.5-flash-lite": "named_default_effort",
  "google/gemini-3.1-pro-preview": "named_default_effort",
  "google/gemini-3.1-flash-lite": "preview_only",
  "anthropic/claude-sonnet-5.5": "too_new",
  "anthropic/claude-sonnet-4.6": "named_default_effort",
  "gpt-6.1-sol": "too_new",
  "claude-sonnet-5-5": "too_new",
  "mistral-large-4": "too_new",
  "mistral-large-latest": "floating_alias",
  "mistral-medium-latest": "floating_alias",
  "mistral-small-latest": "floating_alias",
} as const satisfies Record<UnratedOfferedModelId, ModelUnratedReason>;

/** One snapshot row; ratings are Elo-scale with a published confidence interval. */
export type ModelBenchmarkRating = {
  rating: number;
  ratingLower: number;
  ratingUpper: number;
  rank: number;
  voteCount: number;
};

type ModelBenchmarkSourceEntry =
  (typeof MODEL_BENCHMARK_SOURCES)[OfferedBYOKModelId][number];

/** Every Arena model id the catalog references; the snapshot must cover it. */
export type ModelBenchmarkSourceModelId =
  ModelBenchmarkSourceEntry["sourceModelId"];
