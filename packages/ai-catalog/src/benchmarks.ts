import type { ModelBenchmarkMeasurement } from "./benchmark-frontier";
/**
 * Cost and quality trade-offs across the offered catalog.
 *
 * Quality is the Text Arena (LMArena) rating of an exactly matched model and
 * reasoning-effort variant (`benchmark-sources.ts` + `benchmarks.gen.ts`).
 * Cost is the list price of one typical call. The API classifies once over the
 * whole catalog (`benchmark-frontier.ts`) so clients never ship the rate table
 * or the snapshot.
 */
import {
  MODEL_BENCHMARK_SOURCES,
  MODEL_UNRATED_REASON,
} from "./benchmark-sources";
import type {
  ModelBenchmarkRating,
  ModelUnratedReason,
} from "./benchmark-sources";
import { MODEL_BENCHMARK_RATINGS } from "./benchmarks.gen";
import { getModelRate } from "./index";
import type { OfferedBYOKModelId } from "./index";
import { MODEL_RATE_UNITS_PER_USD, getStandardModelRate } from "./model-rate";

export {
  MODEL_BENCHMARK_CATEGORY,
  MODEL_BENCHMARK_CONFIG,
  MODEL_BENCHMARK_DATASET,
  MODEL_BENCHMARK_LICENCE,
  MODEL_BENCHMARK_NAME,
  MODEL_BENCHMARK_SOURCES,
  MODEL_BENCHMARK_SOURCE_URL,
  MODEL_BENCHMARK_SPLIT,
  MODEL_UNRATED_REASON,
  MODEL_UNRATED_REASONS,
} from "./benchmark-sources";
export type {
  ModelBenchmarkRating,
  ModelBenchmarkSourceModelId,
  ModelUnratedReason,
} from "./benchmark-sources";
export {
  MODEL_BENCHMARK_PUBLISH_DATE,
  MODEL_BENCHMARK_RATINGS,
} from "./benchmarks.gen";

export const TYPICAL_CALL_INPUT_TOKENS = 20_000;
export const TYPICAL_CALL_OUTPUT_TOKENS = 2000;
const TOKENS_PER_RATE_UNIT = 1_000_000;

/**
 * List price in USD of one typical call at the standard (non-cached,
 * below-threshold) rate. Rates are per model, not per effort, so this does not
 * vary with reasoning effort even though higher efforts usually emit more
 * output tokens; the comparison states that assumption beside the chart.
 */
export const getTypicalCallCostUsd = (modelId: string): number | null => {
  const rate = getModelRate(modelId);
  if (rate === undefined) {
    return null;
  }
  const { inputPerMTok, outputPerMTok } = getStandardModelRate(rate);
  const units =
    (inputPerMTok * TYPICAL_CALL_INPUT_TOKENS +
      outputPerMTok * TYPICAL_CALL_OUTPUT_TOKENS) /
    TOKENS_PER_RATE_UNIT;
  return units / MODEL_RATE_UNITS_PER_USD;
};

const MODEL_BENCHMARK_RATINGS_BY_ID: Readonly<
  Record<string, ModelBenchmarkRating>
> = MODEL_BENCHMARK_RATINGS;

/** Every measured variant of an offered model, in source order. */
export const getModelBenchmarkMeasurements = (
  modelId: OfferedBYOKModelId,
): ModelBenchmarkMeasurement[] =>
  MODEL_BENCHMARK_SOURCES[modelId].flatMap(
    ({ sourceModelId, reasoningEffort }) => {
      const measured = MODEL_BENCHMARK_RATINGS_BY_ID[sourceModelId];
      return measured === undefined
        ? []
        : [
            {
              sourceModelId,
              reasoningEffort,
              rating: measured.rating,
              ratingLower: measured.ratingLower,
              ratingUpper: measured.ratingUpper,
            },
          ];
    },
  );

const MODEL_UNRATED_REASON_BY_ID: Readonly<
  Partial<Record<OfferedBYOKModelId, ModelUnratedReason>>
> = MODEL_UNRATED_REASON;

/** Why an offered model has no exact Text Arena row; `null` when it has one. */
export const getModelUnratedReason = (
  modelId: OfferedBYOKModelId,
): ModelUnratedReason | null => MODEL_UNRATED_REASON_BY_ID[modelId] ?? null;
