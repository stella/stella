import { describe, expect, test } from "bun:test";

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
    options: models.filter(({ unconfigured }) => !unconfigured).map(optionOf),
    query,
    selectedValue: selected,
  });

const names = (entries: readonly ModelPickerEntry<ModelPickerOption>[]) =>
  entries.map(({ option, recommendation }) =>
    recommendation === null || recommendation === "frontier"
      ? option.value
      : `${option.value} (${recommendation})`,
  );

const cheapFast: Model = {
  cost: 0.003,
  maker: "openai",
  name: "Luna",
  rating: 1440,
};
const strong: Model = {
  cost: 0.06,
  maker: "openai",
  name: "Sol",
  rating: 1480,
};
const dominated: Model = {
  cost: 0.3,
  maker: "openai",
  name: "Astra",
  rating: 1470,
};
const flash: Model = {
  cost: 0.02,
  maker: "google",
  name: "Flash",
  rating: 1490,
};

describe("model picker split", () => {
  test("recommends the cost and quality frontier and keeps the rest behind All models", () => {
    const result = view([cheapFast, strong, dominated]);
    if (result.type !== "split") {
      throw new Error("expected a split view");
    }
    expect(names(result.recommended)).toEqual(["openai::Luna", "openai::Sol"]);
    expect(names(result.others)).toEqual(["openai::Astra"]);
  });

  test("ranks only models the organization can select", () => {
    // Flash beats Sol, but its provider is not configured here.
    const result = view([
      cheapFast,
      strong,
      dominated,
      { ...flash, unconfigured: true },
    ]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Luna",
      "openai::Sol",
    ]);
  });

  test("keeps an off-frontier selection visible in Recommended", () => {
    const older: Model = {
      cost: 0.2,
      maker: "openai",
      name: "Old",
      rating: 1400,
    };
    const result = view([cheapFast, strong, dominated, older], {
      selected: "openai::Astra",
    });
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Luna",
      "openai::Sol",
      "openai::Astra (selected)",
    ]);
    expect(result.type === "split" && names(result.others)).toEqual([
      "openai::Old",
    ]);
  });

  test("recommends a model once, on its maker's own route", () => {
    const viaAggregator: Model = { ...flash, provider: "openrouter" };
    const result = view([viaAggregator, flash, dominated]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "google::Flash",
    ]);
    expect(result.type === "split" && names(result.others)).toEqual([
      "openrouter::Flash",
      "openai::Astra",
    ]);
  });

  test("recommends an aggregator route when the maker's own is not selectable", () => {
    const result = view([{ ...flash, provider: "openrouter" }, dominated]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openrouter::Flash",
    ]);
  });

  test("recommends the aggregator route when only it was measured", () => {
    const unmeasuredDirect: Model = {
      maker: "google",
      name: "Flash",
      unratedReason: "named_default_effort",
    };
    const result = view([
      { ...flash, provider: "openrouter" },
      unmeasuredDirect,
      dominated,
    ]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openrouter::Flash",
    ]);
  });

  test("searches every model, recommended or not", () => {
    const result = view([cheapFast, strong, dominated], { query: " astr " });
    expect(result.type).toBe("all");
    expect(result.type === "all" && names(result.entries)).toEqual([
      "openai::Astra",
    ]);
  });

  test("stays flat without benchmark data", () => {
    const unrated: Model[] = [
      { maker: "mistral", name: "Large", unratedReason: "floating_alias" },
      { maker: "mistral", name: "Small", unratedReason: "floating_alias" },
    ];
    expect(view(unrated, { selected: "mistral::Small" }).type).toBe("all");
  });

  test("stays flat when every model is recommended", () => {
    expect(view([cheapFast, strong]).type).toBe("all");
  });
});

describe("unrated newest generation", () => {
  const newest: Model = { cost: 0.06, maker: "openai", name: "Sol 2" };

  test("recommends a too-new model as new when its maker is on the frontier", () => {
    const result = view([newest, cheapFast, strong, dominated]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Sol 2 (new)",
      "openai::Luna",
      "openai::Sol",
    ]);
  });

  test("keeps a too-new model under All models when its maker has no frontier model", () => {
    const result = view([newest, flash, dominated]);
    expect(result.type === "split" && names(result.others)).toEqual([
      "openai::Sol 2",
      "openai::Astra",
    ]);
  });

  test("never promotes models unrated for other reasons", () => {
    const preview: Model = {
      maker: "openai",
      name: "Preview",
      unratedReason: "preview_only",
    };
    const alias: Model = {
      maker: "openai",
      name: "Latest",
      unratedReason: "floating_alias",
    };
    const unmeasuredEffort: Model = {
      maker: "openai",
      name: "Routed",
      unratedReason: "named_default_effort",
    };
    const result = view([preview, alias, unmeasuredEffort, cheapFast, strong]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Luna",
      "openai::Sol",
    ]);
  });

  test("recommends the newest model once across routes", () => {
    const result = view([
      { ...newest, provider: "openrouter" },
      newest,
      cheapFast,
      strong,
    ]);
    expect(result.type === "split" && names(result.recommended)).toEqual([
      "openai::Sol 2 (new)",
      "openai::Luna",
      "openai::Sol",
    ]);
    expect(result.type === "split" && names(result.others)).toEqual([
      "openrouter::Sol 2",
    ]);
  });
});
