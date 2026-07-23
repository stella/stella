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
 *  4. Tier coverage — upstream context-price thresholds and every tiered
 *     input/output/cache amount must match the discriminated local schedule.
 *     A new upstream tier cannot remain hidden behind a flat local rate.
 *
 * Models without published upstream cost metadata are skipped for
 * invariants 2 and 3 and reported as a warning by the caller.
 *
 * Extracted from the nightly script so the drift logic is
 * unit-testable; ledger attribution depends on it.
 */

import { getStandardModelRate } from "@stll/ai-catalog";
import type { ModelRate, ModelRateAmounts } from "@stll/ai-catalog";

export type CatalogEntry = { provider: string; modelId: string };

type UpstreamCostAmounts = {
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
};

export type UpstreamCostTier = UpstreamCostAmounts & {
  inputTokenThreshold: number;
};

export type UpstreamCost = UpstreamCostAmounts & {
  inputTokenTiers: readonly UpstreamCostTier[];
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
  const rawTiers = Array.isArray(cost["tiers"]) ? cost["tiers"] : [];
  const inputTokenTiers: UpstreamCostTier[] = [];
  for (const rawTier of rawTiers) {
    if (!isObject(rawTier) || !isObject(rawTier["tier"])) {
      continue;
    }
    const discriminator = rawTier["tier"];
    if (
      (discriminator["type"] !== undefined &&
        discriminator["type"] !== "context") ||
      typeof discriminator["size"] !== "number" ||
      discriminator["size"] <= 0
    ) {
      continue;
    }
    inputTokenTiers.push({
      inputTokenThreshold: discriminator["size"],
      input: readCostField(rawTier, "input"),
      output: readCostField(rawTier, "output"),
      cacheRead: readCostField(rawTier, "cache_read"),
    });
  }
  return {
    input: readCostField(cost, "input"),
    output: readCostField(cost, "output"),
    cacheRead: readCostField(cost, "cache_read"),
    inputTokenTiers,
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
  const sampleAmounts = (
    entry: CatalogEntry,
    label: string,
    rateAmounts: ModelRateAmounts,
    upstreamAmounts: UpstreamCostAmounts,
  ): void => {
    if (upstreamAmounts.input !== undefined) {
      samples.push({
        entry,
        axis: `${label}input`,
        factor: rateAmounts.inputPerMTok / upstreamAmounts.input,
      });
    }
    if (upstreamAmounts.output !== undefined) {
      samples.push({
        entry,
        axis: `${label}output`,
        factor: rateAmounts.outputPerMTok / upstreamAmounts.output,
      });
    }
    if (
      upstreamAmounts.cacheRead !== undefined &&
      rateAmounts.cachedInputPerMTok !== undefined
    ) {
      samples.push({
        entry,
        axis: `${label}cached-input`,
        factor: rateAmounts.cachedInputPerMTok / upstreamAmounts.cacheRead,
      });
    }
  };

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
    const standardRate = getStandardModelRate(rate);
    const cost = costs.get(`${mdProvider}:${entry.modelId}`);
    if (cost === undefined) {
      skipped.push(entry);
      continue;
    }
    if (
      cost.cacheRead !== undefined &&
      standardRate.cachedInputPerMTok === undefined
    ) {
      failures.push({
        entry,
        label: "NO CACHED RATE",
        detail:
          "upstream publishes cache-read pricing but the entry has no " +
          "cachedInputPerMTok; cached tokens are attributed at the full " +
          "input rate",
      });
    }
    sampleAmounts(entry, "", standardRate, cost);

    if (rate.kind === "flat") {
      if (cost.inputTokenTiers.length > 0) {
        failures.push({
          entry,
          label: "NO TIERED RATE",
          detail:
            "upstream publishes long-context pricing but MODEL_RATES is flat",
        });
      }
      continue;
    }

    const matchingTiers = cost.inputTokenTiers.filter(
      (tier) => tier.inputTokenThreshold === rate.inputTokenThreshold,
    );
    if (cost.inputTokenTiers.length !== 1 || matchingTiers.length !== 1) {
      failures.push({
        entry,
        label: "TIER DRIFT",
        detail:
          `expected exactly one upstream context tier at ${rate.inputTokenThreshold} tokens; ` +
          `found ${cost.inputTokenTiers.map((tier) => tier.inputTokenThreshold).join(", ") || "none"}`,
      });
      continue;
    }
    const upstreamTier = matchingTiers[0];
    if (upstreamTier === undefined) {
      continue;
    }
    if (
      upstreamTier.cacheRead !== undefined &&
      rate.aboveThreshold.cachedInputPerMTok === undefined
    ) {
      failures.push({
        entry,
        label: "NO CACHED TIER RATE",
        detail:
          "upstream publishes tiered cache-read pricing but aboveThreshold has no cachedInputPerMTok",
      });
    }
    sampleAmounts(entry, "tiered-", rate.aboveThreshold, upstreamTier);
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
