/**
 * Capability drift checks for the nightly catalog validation
 * (`model-catalog-upstream.ts`), covering the request parameters
 * stella's option builders decide per model:
 *
 *  - Reasoning efforts (`MODEL_REASONING_EFFORTS`): the declared
 *    effort values must match upstream `reasoning_options`. The case
 *    this exists for: a provider makes reasoning mandatory on a model
 *    ("none" disappears from the published values), and a request
 *    built from the stale declaration starts 4xx/5xx-ing.
 *  - Temperature support (`MODEL_TEMPERATURE_SUPPORT`): the declared
 *    boolean must match upstream `temperature`. Sampling-rejecting
 *    models (GPT-5 family, newest Claude) 400 on a `temperature`
 *    override.
 *
 * Both invariants are CI-enforced along with coverage: every
 * checkable offered model must carry entries in both maps. Models
 * whose upstream record lacks the relevant metadata are skipped and
 * reported as a warning by the caller.
 *
 * Extracted from the nightly script so the drift logic is
 * unit-testable; every AI feature's request construction depends on
 * these declarations via `resolveReasoningEffort` and
 * `supportsTemperature`.
 */

import type { ReasoningEffort } from "@stll/ai-catalog";

import type { CatalogEntry } from "./model-catalog-rates";

/** Upstream capability metadata for one model, from models.dev. */
export type UpstreamCapabilities = {
  /** The model reasons at all (models.dev `reasoning`). */
  reasoning: boolean;
  /**
   * Values of the `{ type: "effort" }` entry in
   * `reasoning_options`, or `null` when the model publishes no
   * effort-style control (budget-only, always-on, or non-reasoning).
   */
  effortValues: readonly string[] | null;
  /**
   * models.dev `temperature`: whether the model accepts a temperature
   * override; `null` when the record does not publish it.
   */
  temperature: boolean | null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseUpstreamCapabilities = (
  modelVal: unknown,
): UpstreamCapabilities | null => {
  if (!isObject(modelVal) || typeof modelVal["reasoning"] !== "boolean") {
    return null;
  }
  const options = modelVal["reasoning_options"];
  let effortValues: readonly string[] | null = null;
  if (Array.isArray(options)) {
    for (const option of options) {
      if (
        isObject(option) &&
        option["type"] === "effort" &&
        Array.isArray(option["values"])
      ) {
        const values = option["values"].filter(
          (value): value is string => typeof value === "string",
        );
        effortValues = values.length > 0 ? values : null;
        break;
      }
    }
  }
  return {
    reasoning: modelVal["reasoning"],
    effortValues,
    temperature:
      typeof modelVal["temperature"] === "boolean"
        ? modelVal["temperature"]
        : null,
  };
};

export type CapabilityFailure = {
  entry: CatalogEntry;
  label: string;
  detail: string;
};

export type CapabilityCheckResult = {
  failures: CapabilityFailure[];
  skipped: CatalogEntry[];
};

export type ValidateCapabilitiesOptions = {
  entries: CatalogEntry[];
  /**
   * Catalog provider → models.dev provider key. Unlike the rate check
   * this includes `openrouter`, whose models.dev catalog publishes the
   * OpenRouter-normalized capability metadata per slug.
   */
  checkableProviders: Readonly<Record<string, string>>;
  /** `${modelsDevProvider}:${modelId}` → upstream capability metadata. */
  upstream: ReadonlyMap<string, UpstreamCapabilities>;
  declaredEfforts: Readonly<Record<string, readonly ReasoningEffort[] | null>>;
  declaredTemperature: Readonly<Record<string, boolean>>;
};

const formatValues = (values: readonly string[] | null): string =>
  values === null ? "none (no effort control)" : `[${values.join(", ")}]`;

export const validateCapabilities = ({
  entries,
  checkableProviders,
  upstream,
  declaredEfforts,
  declaredTemperature,
}: ValidateCapabilitiesOptions): CapabilityCheckResult => {
  const failures: CapabilityFailure[] = [];
  const skipped: CatalogEntry[] = [];

  for (const entry of entries) {
    const mdProvider = checkableProviders[entry.provider];
    if (mdProvider === undefined) {
      continue;
    }
    const efforts = declaredEfforts[entry.modelId];
    if (efforts === undefined) {
      failures.push({
        entry,
        label: "NO REASONING CAPABILITY",
        detail: "offered model has no MODEL_REASONING_EFFORTS entry",
      });
      continue;
    }
    const temperatureSupport = declaredTemperature[entry.modelId];
    if (temperatureSupport === undefined) {
      failures.push({
        entry,
        label: "NO TEMPERATURE CAPABILITY",
        detail: "offered model has no MODEL_TEMPERATURE_SUPPORT entry",
      });
      continue;
    }
    const upstreamCapabilities = upstream.get(`${mdProvider}:${entry.modelId}`);
    if (upstreamCapabilities === undefined) {
      skipped.push(entry);
      continue;
    }

    const upstreamValues = upstreamCapabilities.reasoning
      ? upstreamCapabilities.effortValues
      : null;
    const declaredSet = new Set<string>(efforts);
    const upstreamSet = new Set(upstreamValues);
    const effortsMatch =
      declaredSet.size === upstreamSet.size &&
      [...declaredSet].every((value) => upstreamSet.has(value));
    if (!effortsMatch) {
      failures.push({
        entry,
        label: "REASONING DRIFT",
        detail:
          `declared ${formatValues(efforts)} but upstream ` +
          `publishes ${formatValues(upstreamValues)}; a stale declaration ` +
          "lets request construction send an effort the model rejects",
      });
    }

    if (
      upstreamCapabilities.temperature !== null &&
      upstreamCapabilities.temperature !== temperatureSupport
    ) {
      failures.push({
        entry,
        label: "TEMPERATURE DRIFT",
        detail:
          `declared temperature support ${String(temperatureSupport)} but ` +
          `upstream publishes ${String(upstreamCapabilities.temperature)}; ` +
          "a stale declaration sends (or withholds) a sampling override " +
          "the model rejects (or accepts)",
      });
    }
  }

  return { failures, skipped };
};
