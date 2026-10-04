import { classifyBenchmarkModelOptions } from "@stll/ai-catalog/benchmark-frontier";
import type { ModelBenchmarkTradeoff } from "@stll/ai-catalog/benchmark-frontier";

import type { ChatModelBenchmarkOption } from "@/features/chat/queries";

/** The fields of a selectable chat model the picker split needs. */
export type ModelPickerOption = {
  displayName: string;
  /** Brand of the model's maker; differs from `provider` for aggregators. */
  iconProvider: string;
  provider: string;
  value: string;
};

/** The cost and quality data the API sends for one offered route. */
export type ModelPickerBenchmark = Pick<
  ChatModelBenchmarkOption,
  | "availability"
  | "costPerTypicalCallUsd"
  | "iconProvider"
  | "measurements"
  | "provider"
  | "unratedReason"
  | "value"
>;

/**
 * Why a row sits in the Recommended section.
 * - `frontier`: no other selectable model is both cheaper and rated higher.
 * - `new`: too new for Text Arena, from a maker that has a frontier model.
 * - `selected`: off the frontier, kept visible because it is the current pick.
 * - `null`: listed only under All models.
 */
export type ModelRecommendation = "frontier" | "new" | "selected" | null;

export type ModelPickerEntry<TOption extends ModelPickerOption> = {
  option: TOption;
  recommendation: ModelRecommendation;
  /** Trade-off among the selectable models; `null` without benchmark data. */
  tradeoff: ModelBenchmarkTradeoff | null;
};

/**
 * `all`: one flat list, used while searching and whenever a split would not
 * shorten the list. `split`: Recommended rows, then everything else behind
 * one "All models" expander.
 */
export type ModelPickerView<TOption extends ModelPickerOption> =
  | { type: "all"; entries: ModelPickerEntry<TOption>[] }
  | {
      type: "split";
      recommended: ModelPickerEntry<TOption>[];
      others: ModelPickerEntry<TOption>[];
    };

/**
 * Trade-offs among the routes this organization can actually send to. The API
 * classifies over the whole catalog (unconfigured providers included); a
 * model that only an unconfigured provider beats is still the best choice
 * here, so the picker re-derives the frontier over its own routes.
 */
export const classifySelectableModels = (
  options: readonly ModelPickerOption[],
  benchmarks: readonly ModelPickerBenchmark[],
): ReadonlyMap<string, ModelBenchmarkTradeoff> => {
  const selectable = new Set(options.map(({ value }) => value));
  return new Map(
    classifyBenchmarkModelOptions(
      benchmarks.filter(
        ({ availability, value }) =>
          availability === "available" && selectable.has(value),
      ),
    ).map(({ tradeoff, value }) => [value, tradeoff] as const),
  );
};

type Recommendation = Exclude<ModelRecommendation, "selected">;

/**
 * Recommended = the cost and quality Pareto frontier among selectable models.
 *
 * Text Arena has not ranked a model released after the snapshot, so it has
 * no frontier verdict. Hiding it would bury the newest generation, which is
 * what provider defaults track, so an unrated model whose catalogue reason is
 * `too_new` is recommended as `new` whenever a model from the same maker is
 * on the frontier. Unrated models for any other reason (preview-only rows,
 * floating aliases, routes whose default effort Arena did not measure) are
 * never recommended on that basis.
 *
 * The same model reached through several routes (its maker's API and an
 * aggregator) is recommended once: on the maker's own route when that route
 * qualifies, otherwise on the first qualifying route in catalogue order.
 */
const getModelRecommendations = ({
  benchmarks,
  options,
  tradeoffs,
}: {
  benchmarks: readonly ModelPickerBenchmark[];
  options: readonly ModelPickerOption[];
  tradeoffs: ReadonlyMap<string, ModelBenchmarkTradeoff>;
}): ReadonlyMap<string, Recommendation> => {
  const unratedReasons = new Map(
    benchmarks.map(({ unratedReason, value }) => [value, unratedReason]),
  );
  const frontierMakers = new Set(
    options
      .filter(({ value }) => tradeoffs.get(value)?.type === "pareto")
      .map(({ iconProvider }) => iconProvider),
  );
  const recommendationOf = (option: ModelPickerOption): Recommendation => {
    const tradeoff = tradeoffs.get(option.value);
    if (tradeoff?.type === "pareto") {
      return "frontier";
    }
    const unmeasured = tradeoff === undefined || tradeoff.type === "unmeasured";
    return unmeasured &&
      unratedReasons.get(option.value) === "too_new" &&
      frontierMakers.has(option.iconProvider)
      ? "new"
      : null;
  };

  const preferred = new Map<
    string,
    { option: ModelPickerOption; recommendation: Recommendation }
  >();
  for (const option of options) {
    const recommendation = recommendationOf(option);
    if (recommendation === null) {
      continue;
    }
    const key = `${option.iconProvider}::${option.displayName}`;
    const existing = preferred.get(key);
    if (
      existing === undefined ||
      (existing.option.provider !== existing.option.iconProvider &&
        option.provider === option.iconProvider)
    ) {
      preferred.set(key, { option, recommendation });
    }
  }
  return new Map(
    [...preferred.values()].map(
      ({ option, recommendation }) => [option.value, recommendation] as const,
    ),
  );
};

const matchesQuery = (option: ModelPickerOption, query: string): boolean =>
  option.displayName.toLowerCase().includes(query);

/**
 * Splits the picker into Recommended and everything else. Search always
 * covers every model. The current selection stays in Recommended even when
 * it is off the frontier. Without any recommendation (no benchmark data) or
 * without anything left over, the list stays flat.
 */
export const getModelPickerView = <TOption extends ModelPickerOption>({
  benchmarks,
  options,
  query,
  selectedValue,
}: {
  benchmarks: readonly ModelPickerBenchmark[];
  options: readonly TOption[];
  query: string;
  selectedValue: string | null;
}): ModelPickerView<TOption> => {
  const tradeoffs = classifySelectableModels(options, benchmarks);
  const recommendations = getModelRecommendations({
    benchmarks,
    options,
    tradeoffs,
  });
  const entries = options.map((option): ModelPickerEntry<TOption> => ({
    option,
    recommendation:
      recommendations.get(option.value) ??
      (option.value === selectedValue ? "selected" : null),
    tradeoff: tradeoffs.get(option.value) ?? null,
  }));

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length > 0) {
    return {
      type: "all",
      entries: entries.filter(({ option }) =>
        matchesQuery(option, normalizedQuery),
      ),
    };
  }

  const recommended = entries.filter(
    ({ recommendation }) => recommendation !== null,
  );
  const others = entries.filter(
    ({ recommendation }) => recommendation === null,
  );
  const hasRecommendation = recommended.some(
    ({ recommendation }) => recommendation !== "selected",
  );
  if (!hasRecommendation || others.length === 0) {
    return { type: "all", entries };
  }
  return { type: "split", recommended, others };
};
