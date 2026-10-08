import { describe, expect, test } from "bun:test";

import { BYOK_MODEL_OPTIONS, getModelDisplayMetadata } from "@stll/ai-catalog";
import type { BYOKProvider } from "@stll/ai-catalog";

import { getModelPickerView } from "@/components/chat/chat-model-options-menu.logic";
import type {
  ModelPickerBenchmark,
  ModelPickerEntry,
  ModelPickerOption,
  ModelPickerView,
} from "@/components/chat/chat-model-options-menu.logic";

type Model = {
  cost?: number;
  curated?: boolean;
  supersededBy?: string;
  maker: BYOKProvider;
  name: string;
  provider?: BYOKProvider;
  rating?: number;
  unratedReason?: ModelPickerBenchmark["unratedReason"];
  unconfigured?: boolean;
};

const valueOf = ({ maker, name, provider }: Model): string =>
  `${provider ?? maker}::${name}`;

const optionOf = (model: Model): ModelPickerOption => ({
  displayName: model.name,
  iconProvider: model.maker,
  provider: model.provider ?? model.maker,
  value: valueOf(model),
});

const benchmarkOf = (model: Model): ModelPickerBenchmark => ({
  availability: model.unconfigured ? "provider_unconfigured" : "available",
  costPerTypicalCallUsd: model.cost ?? null,
  iconProvider: model.maker,
  measurements:
    model.rating === undefined
      ? []
      : [
          {
            classification: "frontier",
            premium: false,
            rating: model.rating,
            ratingLower: model.rating - 2,
            ratingUpper: model.rating + 2,
            reasoningEffort: "high",
            sourceModelId: `${model.name}-high`,
          },
        ],
  provider: model.provider ?? model.maker,
  unratedReason:
    model.rating === undefined ? (model.unratedReason ?? "too_new") : null,
  value: valueOf(model),
});

const view = (
  models: readonly Model[],
  {
    query = "",
    selected = null,
  }: { query?: string; selected?: string | null } = {},
): ModelPickerView<ModelPickerOption> =>
  getModelPickerView({
    benchmarks: models.map(benchmarkOf),
    lineageOf: (value) => {
      const model = models.find((candidate) => valueOf(candidate) === value);
      return model === undefined
        ? undefined
        : {
            recommended: model.curated === true,
            ...(model.supersededBy === undefined
              ? {}
              : { supersededBy: model.supersededBy }),
          };
    },
    options: models.filter(({ unconfigured }) => !unconfigured).map(optionOf),
    query,
    selectedValue: selected,
  });

const names = (entries: readonly ModelPickerEntry<ModelPickerOption>[]) =>
  entries.map(({ option, recommendation }) =>
    recommendation === null || recommendation === "current"
      ? option.value
      : `${option.value} (${recommendation})`,
  );

const luna: Model = {
  cost: 0.003,
  maker: "openai",
  name: "Luna",
  rating: 1440,
  curated: true,
};
const sol: Model = {
  cost: 0.06,
  maker: "openai",
  name: "Sol",
  rating: 1480,
  curated: true,
};
const astra: Model = {
  cost: 0.3,
  maker: "openai",
  name: "Astra",
  rating: 1470,
};
// Cheaper than its successor and on the cost and quality frontier.
const oldLuna: Model = {
  cost: 0.001,
  maker: "openai",
  name: "Old Luna",
  rating: 1430,
  curated: true,
  supersededBy: "openai::Luna",
};
const flash: Model = {
  cost: 0.02,
  maker: "google",
  name: "Flash",
  rating: 1490,
  curated: true,
};

describe("model picker split", () => {
  test("recommends the curated models and keeps the rest behind All models", () => {
    const result = view([luna, sol, astra, flash]);
    if (result.type !== "split") {
      throw new Error("expected a split view");
    }
    expect(names(result.recommended)).toEqual([
      "openai::Luna",
      "openai::Sol",
      "google::Flash",
    ]);
    expect(names(result.others)).toEqual(["openai::Astra"]);
  });

  test("never recommends a superseded model, even a cheap frontier one", () => {
    const result = view([oldLuna, luna, sol, astra]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Luna",
      "openai::Sol",
    ]);
    expect(result.type === "split" && names(result.others)).toEqual([
      "openai::Old Luna",
      "openai::Astra",
    ]);
  });

  test("a superseded model leaves the trade-off frontier", () => {
    const result = view([oldLuna, luna, sol]);
    const tradeoffOf = (value: string) =>
      (result.type === "split"
        ? [...result.recommended, ...result.others]
        : result.entries
      ).find(({ option }) => option.value === value)?.tradeoff;
    expect(tradeoffOf("openai::Old Luna")).toBeNull();
    expect(tradeoffOf("openai::Luna")?.type).toBe("pareto");
  });

  test("recommends a highly rated current flagship that an older model out-rates", () => {
    const olderOpus: Model = {
      cost: 0.1,
      maker: "anthropic",
      name: "Opus Old",
      rating: 1506,
      supersededBy: "anthropic::Opus",
    };
    const opus: Model = {
      cost: 0.1,
      maker: "anthropic",
      name: "Opus",
      rating: 1504,
      curated: true,
    };
    const result = view([olderOpus, opus, luna]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "anthropic::Opus",
      "openai::Luna",
    ]);
  });

  test("keeps an unrecommended selection visible in Recommended", () => {
    const result = view([luna, sol, astra, oldLuna], {
      selected: "openai::Astra",
    });
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Luna",
      "openai::Sol",
      "openai::Astra (selected)",
    ]);
    expect(result.type === "split" && names(result.others)).toEqual([
      "openai::Old Luna",
    ]);
  });

  test("recommends a model once, on its maker's own route", () => {
    const viaAggregator: Model = { ...flash, provider: "openrouter" };
    const result = view([viaAggregator, flash, astra]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "google::Flash",
    ]);
    expect(result.type === "split" && names(result.others)).toEqual([
      "openrouter::Flash",
      "openai::Astra",
    ]);
  });

  test("recommends an aggregator route when the maker's own is not selectable", () => {
    const result = view([{ ...flash, provider: "openrouter" }, astra]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openrouter::Flash",
    ]);
  });

  test("marks a recommended model too new for Text Arena as new", () => {
    const newest: Model = {
      maker: "openai",
      name: "Sol 2",
      curated: true,
    };
    const result = view([newest, luna, { ...sol, curated: false }]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Sol 2 (new)",
      "openai::Luna",
    ]);
  });

  test("searches every model, recommended or not", () => {
    const result = view([luna, sol, astra], { query: " astr " });
    expect(result.type).toBe("all");
    expect(result.type === "all" && names(result.entries)).toEqual([
      "openai::Astra",
    ]);
  });

  test("stays flat without a recommendation", () => {
    const unrated: Model[] = [
      { maker: "mistral", name: "Large", unratedReason: "floating_alias" },
      { maker: "mistral", name: "Small", unratedReason: "floating_alias" },
    ];
    expect(view(unrated, { selected: "mistral::Small" }).type).toBe("all");
  });

  test("stays flat when every model is recommended", () => {
    expect(view([luna, sol]).type).toBe("all");
  });
});

describe("the real catalogue", () => {
  test("recommends the curated list for an organization with every direct provider", () => {
    // Every provider that serves only its own models (no aggregators).
    const options = Object.entries(BYOK_MODEL_OPTIONS).flatMap(
      ([provider, models]) => {
        const rows = models.map((modelId: string) => ({
          metadata: getModelDisplayMetadata(modelId),
          modelId,
        }));
        return rows.every(({ metadata }) => metadata?.iconProvider === provider)
          ? rows.map(({ metadata, modelId }) => ({
              displayName: metadata?.displayName ?? modelId,
              iconProvider: provider,
              provider,
              value: `${provider}::${modelId}`,
            }))
          : [];
      },
    );
    const result = getModelPickerView({
      benchmarks: [],
      options,
      query: "",
      selectedValue: null,
    });
    expect(
      result.type === "split" &&
        result.recommended.map(({ option }) => option.displayName).toSorted(),
    ).toEqual([
      "Claude Opus 5.5",
      "GPT-6 Luna",
      "GPT-6.1 Sol",
      "Gemini 3.8 Flash",
    ]);
  });
});
