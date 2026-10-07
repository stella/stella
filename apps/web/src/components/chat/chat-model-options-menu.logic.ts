import {
  getModelDisplayMetadata,
  RECOMMENDED_CHAT_MODELS,
} from "@stll/ai-catalog";
import type { ModelDisplayMetadata } from "@stll/ai-catalog";
import { classifyBenchmarkModelOptions } from "@stll/ai-catalog/benchmark-frontier";
import type { ModelBenchmarkTradeoff } from "@stll/ai-catalog/benchmark-frontier";

import { decodeModelSelection } from "@/components/ai-config-role-models.logic";
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
 * - `current`: on the catalogue's curated Recommended list.
 * - `new`: the same, and too new for Text Arena to have ranked it yet.
 * - `selected`: not recommended, kept visible because it is the current pick.
 * - `null`: listed only under All models.
 */
export type ModelRecommendation = "current" | "new" | "selected" | null;

/** The catalogue's say on a model: whether it is curated, its successor. */
export type ModelLineage = {
  recommended: boolean;
  supersededBy?: string;
};

// Any route to a curated model qualifies, so match on the product shown.
const isRecommendedProduct = ({
  displayName,
  iconProvider,
}: ModelDisplayMetadata): boolean =>
  RECOMMENDED_CHAT_MODELS.some((modelId) => {
    const curated = getModelDisplayMetadata(modelId);
    return (
      curated?.displayName === displayName &&
      curated.iconProvider === iconProvider
    );
  });

/** Picker values are encoded selections ("provider::modelId"). */
const catalogueLineage = (value: string): ModelLineage | undefined => {
  const selection = decodeModelSelection(value);
  const metadata =
    selection === null ? null : getModelDisplayMetadata(selection.modelId);
  if (metadata === null) {
    return undefined;
  }
  return {
    recommended: isRecommendedProduct(metadata),
    ...(metadata.supersededBy === undefined
      ? {}
      : { supersededBy: metadata.supersededBy }),
  };
};

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
const classifySelectableModels = (
  options: readonly ModelPickerOption[],
  benchmarks: readonly ModelPickerBenchmark[],
  lineageOf: (value: string) => ModelLineage | undefined = catalogueLineage,
): ReadonlyMap<string, ModelBenchmarkTradeoff> => {
  const selectable = new Set(options.map(({ value }) => value));
  // A superseded model is never the trade-off to make, so it neither sits on
  // the frontier nor pushes a current model off it.
  return new Map(
    classifyBenchmarkModelOptions(
      benchmarks.filter(
        ({ availability, value }) =>
          availability === "available" &&
          selectable.has(value) &&
          lineageOf(value)?.supersededBy === undefined,
      ),
    ).map(({ tradeoff, value }) => [value, tradeoff] as const),
  );
};

type Recommendation = Exclude<ModelRecommendation, "selected">;

/**
 * Recommended = the catalogue's curated list. Benchmarks do not pick it: a
 * Pareto frontier has no notion of generation, so it favours whichever
 * superseded model is cheap or out-rates its successor within noise. A
 * superseded model is never recommended, even if listed.
 *
 * The same model reached through several routes (its maker's API and an
 * aggregator) is recommended once: on the maker's own route when offered,
 * otherwise on the first route in catalogue order.
 */
const getModelRecommendations = ({
  benchmarks,
  lineageOf,
  options,
}: {
  benchmarks: readonly ModelPickerBenchmark[];
  lineageOf: (value: string) => ModelLineage | undefined;
  options: readonly ModelPickerOption[];
}): ReadonlyMap<string, Recommendation> => {
  const unratedReasons = new Map(
    benchmarks.map(({ unratedReason, value }) => [value, unratedReason]),
  );
  const preferred = new Map<
    string,
    { option: ModelPickerOption; recommendation: Recommendation }
  >();
  for (const option of options) {
    const lineage = lineageOf(option.value);
    if (lineage?.recommended !== true || lineage.supersededBy !== undefined) {
      continue;
    }
    const recommendation: Recommendation =
      unratedReasons.get(option.value) === "too_new" ? "new" : "current";
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
 * the catalogue does not recommend it. Without any recommendation (no benchmark data) or
 * without anything left over, the list stays flat.
 */
export const getModelPickerView = <TOption extends ModelPickerOption>({
  benchmarks,
  lineageOf = catalogueLineage,
  options,
  query,
  selectedValue,
}: {
  benchmarks: readonly ModelPickerBenchmark[];
  lineageOf?: (value: string) => ModelLineage | undefined;
  options: readonly TOption[];
  query: string;
  selectedValue: string | null;
}): ModelPickerView<TOption> => {
  const tradeoffs = classifySelectableModels(options, benchmarks, lineageOf);
  const recommendations = getModelRecommendations({
    benchmarks,
    lineageOf,
    options,
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
