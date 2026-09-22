/**
 * Pure Pareto and uncertainty classification over measured model variants.
 * Free of the rate table and the ratings snapshot so a client can reuse it on
 * already classified data without shipping either.
 */
import type { BYOKProvider, ReasoningEffort } from "./index";

export type ModelBenchmarkMeasurement = {
  sourceModelId: string;
  reasoningEffort: ReasoningEffort | null;
  rating: number;
  ratingLower: number;
  ratingUpper: number;
};

export const MODEL_BENCHMARK_AVAILABILITIES = [
  "available",
  "provider_unconfigured",
] as const;

export type ModelBenchmarkAvailability =
  (typeof MODEL_BENCHMARK_AVAILABILITIES)[number];

/** One offered route with its measured variants and list price. */
export type BenchmarkModelOption = {
  availability: ModelBenchmarkAvailability;
  costPerTypicalCallUsd: number | null;
  measurements: readonly ModelBenchmarkMeasurement[];
  /** Brand of the model's creator; differs from `provider` for aggregators. */
  iconProvider: BYOKProvider;
  provider: BYOKProvider;
  value: string;
};

export type ModelBenchmarkPoint = {
  availability: ModelBenchmarkAvailability;
  costPerTypicalCallUsd: number;
  id: string;
  isDirectRoute: boolean;
  modelValue: string;
  reasoningEffort: ReasoningEffort | null;
  rating: number;
  ratingLower: number;
  ratingUpper: number;
  sourceModelId: string;
};

export const buildModelBenchmarkPoints = (
  options: readonly BenchmarkModelOption[],
): ModelBenchmarkPoint[] =>
  options.flatMap((option) => {
    const cost = option.costPerTypicalCallUsd;
    if (cost === null) {
      return [];
    }
    return option.measurements.map((measurement) => ({
      availability: option.availability,
      costPerTypicalCallUsd: cost,
      id: `${option.value}::${measurement.sourceModelId}`,
      isDirectRoute: option.provider === option.iconProvider,
      modelValue: option.value,
      reasoningEffort: measurement.reasoningEffort,
      rating: measurement.rating,
      ratingLower: measurement.ratingLower,
      ratingUpper: measurement.ratingUpper,
      sourceModelId: measurement.sourceModelId,
    }));
  });

const AVAILABILITY_PREFERENCE = {
  available: 2,
  provider_unconfigured: 0,
} as const satisfies Record<ModelBenchmarkAvailability, number>;

const pointPreference = (point: ModelBenchmarkPoint): number =>
  AVAILABILITY_PREFERENCE[point.availability] + (point.isDirectRoute ? 1 : 0);

/**
 * One point per Arena row: several routes (first-party, aggregator) can serve
 * the same measured variant. Prefer a route the organization can use, then
 * the model creator's own API, then the lexically first id for determinism.
 */
export const getUniqueModelBenchmarkPoints = <
  TPoint extends ModelBenchmarkPoint,
>(
  points: readonly TPoint[],
): TPoint[] => {
  const unique = new Map<string, TPoint>();
  for (const point of points) {
    const existing = unique.get(point.sourceModelId);
    if (existing === undefined) {
      unique.set(point.sourceModelId, point);
      continue;
    }
    const preference = pointPreference(point) - pointPreference(existing);
    if (preference > 0 || (preference === 0 && point.id < existing.id)) {
      unique.set(point.sourceModelId, point);
    }
  }
  return [...unique.values()];
};

/** Pareto dominance on point estimates: no costlier and no worse, one strictly. */
export const dominatesBenchmarkPoint = (
  candidate: ModelBenchmarkPoint,
  target: ModelBenchmarkPoint,
): boolean =>
  candidate.costPerTypicalCallUsd <= target.costPerTypicalCallUsd &&
  candidate.rating >= target.rating &&
  (candidate.costPerTypicalCallUsd < target.costPerTypicalCallUsd ||
    candidate.rating > target.rating);

/** No costlier, and better beyond both confidence intervals. */
export const statisticallyDominatesBenchmarkPoint = (
  candidate: ModelBenchmarkPoint,
  target: ModelBenchmarkPoint,
): boolean =>
  candidate.costPerTypicalCallUsd <= target.costPerTypicalCallUsd &&
  candidate.ratingLower > target.ratingUpper;

const compareIds = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** Non-dominated points, ordered by cost then rating. */
export const getParetoFrontier = <TPoint extends ModelBenchmarkPoint>(
  points: readonly TPoint[],
): TPoint[] =>
  points
    .filter(
      (point) =>
        !points.some((candidate) => dominatesBenchmarkPoint(candidate, point)),
    )
    .toSorted(
      (left, right) =>
        left.costPerTypicalCallUsd - right.costPerTypicalCallUsd ||
        left.rating - right.rating ||
        compareIds(left.id, right.id),
    );

export const MODEL_BENCHMARK_CLASSIFICATIONS = [
  "frontier",
  "near_frontier",
  "dominated",
] as const;

export type ModelBenchmarkClassification =
  (typeof MODEL_BENCHMARK_CLASSIFICATIONS)[number];

/**
 * Frontier: not dominated on point estimates. Dominated: some point is no
 * costlier and its lower bound clears this point's upper bound. Everything
 * else is within uncertainty of the frontier.
 */
export const classifyBenchmarkPoints = (
  points: readonly ModelBenchmarkPoint[],
): ReadonlyMap<string, ModelBenchmarkClassification> => {
  const frontierIds = new Set(getParetoFrontier(points).map(({ id }) => id));
  const classifications = new Map<string, ModelBenchmarkClassification>();
  for (const point of points) {
    if (frontierIds.has(point.id)) {
      classifications.set(point.id, "frontier");
      continue;
    }
    classifications.set(
      point.id,
      points.some((candidate) =>
        statisticallyDominatesBenchmarkPoint(candidate, point),
      )
        ? "dominated"
        : "near_frontier",
    );
  }
  return classifications;
};

export const PREMIUM_COST_MULTIPLIER = 3;

/** Points costing at least three times the median cost per typical call. */
export const getPremiumBenchmarkPointIds = (
  points: readonly ModelBenchmarkPoint[],
): ReadonlySet<string> => {
  const costs = points
    .map(({ costPerTypicalCallUsd }) => costPerTypicalCallUsd)
    .toSorted((left, right) => left - right);
  const middle = Math.floor(costs.length / 2);
  const upperMiddle = costs.at(middle);
  if (upperMiddle === undefined) {
    return new Set();
  }
  const median =
    costs.length % 2 === 0
      ? ((costs.at(middle - 1) ?? upperMiddle) + upperMiddle) / 2
      : upperMiddle;
  const threshold = median * PREMIUM_COST_MULTIPLIER;
  return new Set(
    points
      .filter(({ costPerTypicalCallUsd }) => costPerTypicalCallUsd >= threshold)
      .map(({ id }) => id),
  );
};

export type ClassifiedBenchmarkMeasurement = ModelBenchmarkMeasurement & {
  classification: ModelBenchmarkClassification;
  premium: boolean;
};

export type ModelBenchmarkTradeoff = {
  dominatedReasoningEfforts: readonly (ReasoningEffort | null)[];
  premiumReasoningEfforts: readonly (ReasoningEffort | null)[];
  type: "dominated" | "near_frontier" | "pareto" | "unmeasured";
};

export type ClassifiedBenchmarkModelOption<
  TOption extends BenchmarkModelOption,
> = Omit<TOption, "measurements"> & {
  measurements: ClassifiedBenchmarkMeasurement[];
  tradeoff: ModelBenchmarkTradeoff;
};

const tradeoffType = (
  measurements: readonly ClassifiedBenchmarkMeasurement[],
): ModelBenchmarkTradeoff["type"] => {
  if (measurements.length === 0) {
    return "unmeasured";
  }
  const classifications = new Set(
    measurements.map(({ classification }) => classification),
  );
  if (classifications.has("frontier")) {
    return "pareto";
  }
  if (classifications.has("near_frontier")) {
    return "near_frontier";
  }
  return "dominated";
};

export const getModelBenchmarkTradeoff = (
  measurements: readonly ClassifiedBenchmarkMeasurement[],
): ModelBenchmarkTradeoff => ({
  dominatedReasoningEfforts: measurements
    .filter(({ classification }) => classification === "dominated")
    .map(({ reasoningEffort }) => reasoningEffort),
  premiumReasoningEfforts: measurements
    .filter(({ premium }) => premium)
    .map(({ reasoningEffort }) => reasoningEffort),
  type: tradeoffType(measurements),
});

/**
 * Classify every measured variant once over the whole deduplicated set, then
 * project the result back onto each route. A route that shares an Arena row
 * with the preferred route inherits that row's classification.
 */
export const classifyBenchmarkModelOptions = <
  TOption extends BenchmarkModelOption,
>(
  options: readonly TOption[],
): ClassifiedBenchmarkModelOption<TOption>[] => {
  const points = getUniqueModelBenchmarkPoints(
    buildModelBenchmarkPoints(options),
  );
  const classifications = classifyBenchmarkPoints(points);
  const premiumIds = getPremiumBenchmarkPointIds(points);
  const bySourceModelId = new Map(
    points.map((point) => [point.sourceModelId, point] as const),
  );

  return options.map((option) => {
    const measurements = option.measurements.flatMap((measurement) => {
      const point = bySourceModelId.get(measurement.sourceModelId);
      const classification =
        point === undefined ? undefined : classifications.get(point.id);
      if (point === undefined || classification === undefined) {
        return [];
      }
      return [
        {
          ...measurement,
          classification,
          premium: premiumIds.has(point.id),
        },
      ];
    });
    return {
      ...option,
      measurements,
      tradeoff: getModelBenchmarkTradeoff(measurements),
    };
  });
};
