/**
 * Reasoning-capability drift checks for the nightly catalog validation
 * (`model-catalog-upstream.ts`). Two invariants, both CI-enforced:
 *
 *  1. Coverage — every checkable offered model must carry a
 *     `MODEL_REASONING_EFFORTS` entry. (Also enforced at compile time
 *     for the BYOK lists; this covers the runtime catalog.)
 *  2. Drift — the declared effort values must match what upstream
 *     publishes (models.dev `reasoning_options`, first-party and
 *     openrouter catalogs). The case this exists for: a provider makes
 *     reasoning mandatory on a model ("none" disappears from the
 *     published values), and a request built from the stale
 *     declaration starts 4xx/5xx-ing — with this check it fails CI
 *     instead.
 *
 * Models whose upstream record carries no reasoning metadata are
 * skipped and reported as a warning by the caller.
 *
 * Extracted from the nightly script so the drift logic is
 * unit-testable; every AI feature's request construction depends on
 * these declarations via `resolveReasoningEffort`.
 */

import type { ReasoningEffort } from "@stll/ai-catalog";

import type { CatalogEntry } from "./model-catalog-rates";

/** Upstream reasoning metadata for one model, from models.dev. */
export type UpstreamReasoning = {
  /** The model reasons at all (models.dev `reasoning`). */
  reasoning: boolean;
  /**
   * Values of the `{ type: "effort" }` entry in
   * `reasoning_options`, or `null` when the model publishes no
   * effort-style control (budget-only, always-on, or non-reasoning).
   */
  effortValues: readonly string[] | null;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseUpstreamReasoning = (
  modelVal: unknown,
): UpstreamReasoning | null => {
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
  return { reasoning: modelVal["reasoning"], effortValues };
};

export type ReasoningFailure = {
  entry: CatalogEntry;
  label: string;
  detail: string;
};

export type ReasoningCheckResult = {
  failures: ReasoningFailure[];
  skipped: CatalogEntry[];
};

export type ValidateReasoningOptions = {
  entries: CatalogEntry[];
  /**
   * Catalog provider → models.dev provider key. Unlike the rate check
   * this includes `openrouter`, whose models.dev catalog publishes the
   * OpenRouter-normalized effort values per slug.
   */
  checkableProviders: Readonly<Record<string, string>>;
  /** `${modelsDevProvider}:${modelId}` → upstream reasoning metadata. */
  upstream: ReadonlyMap<string, UpstreamReasoning>;
  declared: Readonly<Record<string, readonly ReasoningEffort[] | null>>;
};

const formatValues = (values: readonly string[] | null): string =>
  values === null ? "none (no effort control)" : `[${values.join(", ")}]`;

export const validateReasoning = ({
  entries,
  checkableProviders,
  upstream,
  declared,
}: ValidateReasoningOptions): ReasoningCheckResult => {
  const failures: ReasoningFailure[] = [];
  const skipped: CatalogEntry[] = [];

  for (const entry of entries) {
    const mdProvider = checkableProviders[entry.provider];
    if (mdProvider === undefined) {
      continue;
    }
    const declaredEfforts = declared[entry.modelId];
    if (declaredEfforts === undefined) {
      failures.push({
        entry,
        label: "NO REASONING CAPABILITY",
        detail: "offered model has no MODEL_REASONING_EFFORTS entry",
      });
      continue;
    }
    const upstreamReasoning = upstream.get(`${mdProvider}:${entry.modelId}`);
    if (upstreamReasoning === undefined) {
      skipped.push(entry);
      continue;
    }
    const upstreamValues =
      upstreamReasoning.reasoning === false
        ? null
        : upstreamReasoning.effortValues;
    const declaredSet = new Set<string>(declaredEfforts);
    const upstreamSet = new Set(upstreamValues);
    const matches =
      declaredSet.size === upstreamSet.size &&
      [...declaredSet].every((value) => upstreamSet.has(value));
    if (matches) {
      continue;
    }
    failures.push({
      entry,
      label: "REASONING DRIFT",
      detail:
        `declared ${formatValues(declaredEfforts)} but upstream ` +
        `publishes ${formatValues(upstreamValues)}; a stale declaration ` +
        "lets request construction send an effort the model rejects",
    });
  }

  return { failures, skipped };
};
