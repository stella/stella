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
 *  - Temperature policy (`MODEL_TEMPERATURE_POLICIES`): `"emit"` is
 *    allowed only while upstream positively reports support. `"omit"`
 *    is always safe because providers may accept but ignore a deprecated
 *    parameter before eventually rejecting it.
 *
 * Both invariants are CI-enforced along with coverage: every
 * checkable offered model must carry entries in both maps. Models
 * whose upstream record lacks the relevant metadata are skipped and
 * reported as a warning by the caller.
 *
 * Extracted from the nightly script so the drift logic is
 * unit-testable; every AI feature's request construction depends on
 * these declarations via `resolveReasoningEffort` and
 * `shouldEmitTemperature`.
 */

import { panic } from "better-result";

import type { ReasoningEffort, TemperaturePolicy } from "@stll/ai-catalog";

import type { CatalogEntry } from "./model-catalog-rates";

const GEMINI_TEMPERATURE_OMISSION_CUTOFF = "2026-07-21";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

type ResolveTemperaturePolicyOptions = {
  modelId: string;
  provider: string;
  releaseDate: string | null;
  upstreamSupportsTemperature: boolean;
};

/**
 * Google deprecated sampling parameters for Gemini 3.6 Flash,
 * Gemini 3.5 Flash-Lite, and future Gemini releases. models.dev still
 * reports those parameters as accepted while Google ignores them, so the
 * request policy must be stricter than the upstream acceptance bit.
 *
 * https://ai.google.dev/gemini-api/docs/latest-model
 */
export const resolveTemperaturePolicy = ({
  modelId,
  provider,
  releaseDate,
  upstreamSupportsTemperature,
}: ResolveTemperaturePolicyOptions): TemperaturePolicy => {
  if (!upstreamSupportsTemperature) {
    return "omit";
  }

  const isGoogleModel =
    provider === "google" ||
    (provider === "openrouter" && modelId.startsWith("google/gemini-"));
  if (!isGoogleModel) {
    return "emit";
  }
  if (releaseDate === null || !ISO_DATE_PATTERN.test(releaseDate)) {
    return panic(
      `${provider}/${modelId}: Google model lacks a valid release_date; ` +
        "cannot apply the reviewed temperature policy cutoff",
    );
  }
  return releaseDate >= GEMINI_TEMPERATURE_OMISSION_CUTOFF ? "omit" : "emit";
};

/** Upstream capability metadata for one model, from models.dev. */
export type UpstreamCapabilities = {
  /** ISO release date used by reviewed provider policy cutovers. */
  releaseDate: string | null;
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
  let hasToggle = false;
  if (Array.isArray(options)) {
    for (const option of options) {
      if (!isObject(option)) {
        continue;
      }
      if (option["type"] === "toggle") {
        hasToggle = true;
        continue;
      }
      if (
        effortValues === null &&
        option["type"] === "effort" &&
        Array.isArray(option["values"])
      ) {
        const values = option["values"].filter(
          (value): value is string => typeof value === "string",
        );
        effortValues = values.length > 0 ? values : null;
      }
    }
  }
  // A separate `{ type: "toggle" }` option means reasoning can be
  // disabled even when the effort list omits "none"; fold it in so a
  // representational shift upstream does not read as false drift.
  // Toggle-only models (no effort list) stay `null`: there is no
  // effort vocabulary to send.
  if (hasToggle && effortValues !== null && !effortValues.includes("none")) {
    effortValues = ["none", ...effortValues];
  }
  return {
    releaseDate:
      typeof modelVal["release_date"] === "string"
        ? modelVal["release_date"]
        : null,
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
  declaredTemperaturePolicies: Readonly<Record<string, TemperaturePolicy>>;
  /**
   * Model ids declared via `CAPABILITY_OVERRIDES` because the upstream
   * source does not cover them; skipped silently instead of being
   * reported as unverifiable every night.
   */
  overriddenIds?: ReadonlySet<string>;
};

const formatValues = (values: readonly string[] | null): string =>
  values === null ? "none (no effort control)" : `[${values.join(", ")}]`;

export const validateCapabilities = ({
  entries,
  checkableProviders,
  upstream,
  declaredEfforts,
  declaredTemperaturePolicies,
  overriddenIds,
}: ValidateCapabilitiesOptions): CapabilityCheckResult => {
  const failures: CapabilityFailure[] = [];
  const skipped: CatalogEntry[] = [];

  for (const entry of entries) {
    const mdProvider = checkableProviders[entry.provider];
    if (mdProvider === undefined) {
      continue;
    }
    if (overriddenIds?.has(entry.modelId)) {
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
    const temperaturePolicy = declaredTemperaturePolicies[entry.modelId];
    if (temperaturePolicy === undefined) {
      failures.push({
        entry,
        label: "NO TEMPERATURE POLICY",
        detail: "offered model has no MODEL_TEMPERATURE_POLICIES entry",
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

    const expectedTemperaturePolicy = resolveTemperaturePolicy({
      modelId: entry.modelId,
      provider: entry.provider,
      releaseDate: upstreamCapabilities.releaseDate,
      upstreamSupportsTemperature: upstreamCapabilities.temperature === true,
    });
    if (temperaturePolicy === "emit" && expectedTemperaturePolicy === "omit") {
      failures.push({
        entry,
        label: "UNSAFE TEMPERATURE POLICY",
        detail:
          "declared temperature policy emit but the reviewed provider policy " +
          "requires omission; a stale declaration may send a rejected, " +
          "deprecated, or ignored sampling override",
      });
    }
  }

  return { failures, skipped };
};
