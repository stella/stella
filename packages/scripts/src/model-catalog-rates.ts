/**
 * Rate-table consistency checks for the nightly catalog validation
 * (`model-catalog-upstream.ts`). Three invariants, all CI-enforced:
 *
 *  1. Coverage — every offered first-party model must carry an
 *     explicit `MODEL_RATES` entry, so a newly offered model can't
 *     silently fall through to the defensive fallback rate. (Also
 *     enforced at compile time for the BYOK lists; this check covers
 *     the runtime catalog, defaults included.)
 *  2. Consistency — all entries share one normalization against
 *     upstream cost metadata. A deviating entry means the table went
 *     stale (provider repriced, or an entry was copied from a
 *     predecessor model) and is mis-attributing ledger usage.
 *  3. Cached-rate coverage — when upstream publishes cache-read
 *     pricing, the entry must carry `cachedInputPerMTok`; otherwise
 *     cached tokens are attributed at the full input rate.
 *
 * Models without published upstream cost metadata are skipped for
 * invariants 2 and 3 and reported as a warning by the caller.
 *
 * Extracted from the nightly script so the drift logic is
 * unit-testable; ledger attribution depends on it.
 */

import type { ModelRate } from "@stll/ai-catalog";

export type CatalogEntry = { provider: string; modelId: string };

export type UpstreamCost = {
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readCostField = (
  cost: Record<string, unknown>,
  field: string,
): number | undefined => {
  const value = cost[field];
  return typeof value === "number" && value > 0 ? value : undefined;
};

export const parseUpstreamCost = (modelVal: unknown): UpstreamCost | null => {
  if (!isObject(modelVal) || !isObject(modelVal["cost"])) {
    return null;
  }
  const cost = modelVal["cost"];
  return {
    input: readCostField(cost, "input"),
    output: readCostField(cost, "output"),
    cacheRead: readCostField(cost, "cache_read"),
  };
};

export const RATE_DRIFT_TOLERANCE = 0.01;

export type RateFailure = {
  entry: CatalogEntry;
  label: string;
  detail: string;
};

export type RateCheckResult = {
  failures: RateFailure[];
  skipped: CatalogEntry[];
};

export type ValidateRatesOptions = {
  entries: CatalogEntry[];
  /**
   * Catalog provider → models.dev provider key, for the first-party
   * providers whose IDs the upstream catalog indexes directly.
   */
  firstPartyProviders: Readonly<Record<string, string>>;
  /** `${modelsDevProvider}:${modelId}` → upstream cost metadata. */
  costs: ReadonlyMap<string, UpstreamCost>;
  rates: Readonly<Record<string, ModelRate>>;
};

export const validateRates = ({
  entries,
  firstPartyProviders,
  costs,
  rates,
}: ValidateRatesOptions): RateCheckResult => {
  const failures: RateFailure[] = [];
  const skipped: CatalogEntry[] = [];
  type FactorSample = { entry: CatalogEntry; axis: string; factor: number };
  const samples: FactorSample[] = [];

  for (const entry of entries) {
    const mdProvider = firstPartyProviders[entry.provider];
    if (mdProvider === undefined) {
      continue;
    }
    const rate = rates[entry.modelId];
    if (rate === undefined) {
      failures.push({
        entry,
        label: "NO RATE",
        detail: "offered model has no MODEL_RATES entry",
      });
      continue;
    }
    const cost = costs.get(`${mdProvider}:${entry.modelId}`);
    if (cost === undefined) {
      skipped.push(entry);
      continue;
    }
    if (cost.cacheRead !== undefined && rate.cachedInputPerMTok === undefined) {
      failures.push({
        entry,
        label: "NO CACHED RATE",
        detail:
          "upstream publishes cache-read pricing but the entry has no " +
          "cachedInputPerMTok; cached tokens are attributed at the full " +
          "input rate",
      });
    }
    if (cost.input !== undefined) {
      samples.push({
        entry,
        axis: "input",
        factor: rate.inputPerMTok / cost.input,
      });
    }
    if (cost.output !== undefined) {
      samples.push({
        entry,
        axis: "output",
        factor: rate.outputPerMTok / cost.output,
      });
    }
    if (cost.cacheRead !== undefined && rate.cachedInputPerMTok !== undefined) {
      samples.push({
        entry,
        axis: "cached-input",
        factor: rate.cachedInputPerMTok / cost.cacheRead,
      });
    }
  }

  // The reference normalization factor is the median sample, so a
  // single drifted entry is flagged rather than dragging the baseline.
  const sortedFactors = samples.map((s) => s.factor).sort((a, b) => a - b);
  const reference = sortedFactors.at(Math.floor(sortedFactors.length / 2));
  if (reference === undefined) {
    return { failures, skipped };
  }

  const driftedAxes = new Map<
    string,
    { entry: CatalogEntry; axes: string[] }
  >();
  for (const sample of samples) {
    if (Math.abs(sample.factor / reference - 1) <= RATE_DRIFT_TOLERANCE) {
      continue;
    }
    const key = `${sample.entry.provider}::${sample.entry.modelId}`;
    const drifted = driftedAxes.get(key) ?? { entry: sample.entry, axes: [] };
    drifted.axes.push(sample.axis);
    driftedAxes.set(key, drifted);
  }
  for (const { entry, axes } of driftedAxes.values()) {
    failures.push({
      entry,
      label: "RATE DRIFT",
      detail: `${axes.join(", ")} rate inconsistent with upstream cost metadata`,
    });
  }
  return { failures, skipped };
};
