/**
 * Per-model usage conversion for the usage ledger.
 *
 * This module converts actual provider usage (input / output /
 * cached tokens) into the ledger's normalized integer units. The
 * analytics callback in `lib/analytics/tanstack-ai.ts` is the
 * natural caller because it receives provider usage from TanStack
 * chat middleware.
 */

import { panic } from "better-result";

import { getModelRate, resolveModelRate } from "@stll/ai-catalog";
import type { ModelRate } from "@stll/ai-catalog";

import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { TelemetryError } from "@/api/lib/errors/tagged-errors";
import {
  ACTION_WEIGHTS,
  computeUsageUnitCost,
  SERVICE_TIER_MULTIPLIERS,
} from "@/api/lib/usage/action-weights";

/**
 * Internal ledger normalization factor. Keeping the denominator
 * integer-only avoids floating point drift in consumption rows.
 */
export const MICRO_UNITS_PER_USAGE_UNIT = 100;

/**
 * Conservative default used for any model not in the catalog rate table.
 * Picked above the typical low-tier model rate so unknown
 * models are attributed defensively rather than escaping the meter.
 */
const FALLBACK_RATE: ModelRate = {
  kind: "flat",
  inputPerMTok: 500_000,
  outputPerMTok: 2_000_000,
};

const ONE_MILLION_BIGINT = 1_000_000n;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// Model ids already reported for a catalog miss this process, so a hot
// billing path can't spam telemetry.
const reportedRateMissModelIds = new Set<string>();

/**
 * A miss means `modelId` isn't in the published rate table (a new or
 * mistyped model id). Instance-key dispatch refuses unrated models
 * pre-flight (`assertInstanceModelRated` in `tanstack-ai-models.ts`),
 * so by the time usage reaches this post-flight path a miss should be
 * BYOK attribution only. `FALLBACK_RATE` remains as the backstop —
 * settlement cannot refuse retroactively — and every miss is reported
 * so an unrecognized model cannot mis-attribute silently.
 */
const getModelRateOrFallback = (modelId: string): ModelRate => {
  const rate = getModelRate(modelId);
  if (rate) {
    return rate;
  }

  if (!reportedRateMissModelIds.has(modelId)) {
    reportedRateMissModelIds.add(modelId);
    captureError(
      new TelemetryError({
        message: "Usage rate lookup missed catalog; billing at fallback rate",
      }),
      { source: "usage-unit-model", modelId },
    );
  }

  return FALLBACK_RATE;
};

const isNonNegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const scaleTokenCost = (tokens: number, ratePerMTok: number): number => {
  if (!isNonNegativeSafeInteger(ratePerMTok)) {
    panic("usage rates must be non-negative safe integers");
  }
  const scaled =
    (BigInt(tokens) * BigInt(ratePerMTok) + ONE_MILLION_BIGINT - 1n) /
    ONE_MILLION_BIGINT;
  if (scaled > MAX_SAFE_INTEGER_BIGINT) {
    panic("computed usage component exceeds the safe integer range");
  }
  return Number(scaled);
};

type UsageInput = {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens that were served from the provider's prompt cache.
   * Where the model offers a cache adjustment we count these at
   * `cachedInputPerMTok`; otherwise they're treated as normal
   * input tokens. Defaults to 0.
   */
  cacheReadTokens?: number;
};

// Model id + field pairs already reported for a count anomaly this process,
// so a hot billing path can't spam telemetry.
const reportedCountAnomalyKeys = new Set<string>();

/**
 * Provider token counts are external input, not an internal invariant, so an
 * inconsistent count normalizes into the valid domain and is reported once per
 * model + field instead of aborting the metering path. Mirrors the catalog-miss
 * handling above (capture + safe fallback) rather than `panic`.
 */
const reportUsageCountAnomaly = ({
  modelId,
  field,
  value,
}: {
  modelId: string;
  field: string;
  value: number;
}): void => {
  const key = `${modelId}:${field}`;
  if (reportedCountAnomalyKeys.has(key)) {
    return;
  }
  reportedCountAnomalyKeys.add(key);
  captureError(
    new TelemetryError({
      message: "Provider usage count outside the valid domain; normalized",
    }),
    { source: "usage-unit-model", modelId, field, value: String(value) },
  );
};

/**
 * Floor a provider-reported token count into the non-negative safe-integer
 * domain. Anything outside it (negative, fractional, non-finite, or above the
 * safe-integer ceiling) becomes zero so a single malformed payload cannot
 * distort or abort settlement.
 */
const normalizeTokenCount = (
  value: number,
  field: string,
  modelId: string,
): number => {
  if (isNonNegativeSafeInteger(value)) {
    return value;
  }
  reportUsageCountAnomaly({ modelId, field, value });
  return 0;
};

/**
 * Convert token usage into normalized micro-units using the
 * model's public rate table. Provider token counts are external input, so this
 * shared boundary normalizes them before they reach the ledger rather than
 * aborting the process on a malformed or inconsistent payload.
 */
export const computeRawUsageMicroUnits = ({
  modelId,
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
}: UsageInput): number => {
  const safeInputTokens = normalizeTokenCount(
    inputTokens,
    "inputTokens",
    modelId,
  );
  const safeOutputTokens = normalizeTokenCount(
    outputTokens,
    "outputTokens",
    modelId,
  );
  const reportedCacheReadTokens = normalizeTokenCount(
    cacheReadTokens,
    "cacheReadTokens",
    modelId,
  );
  // Cache reads are a subset of the input tokens. A provider that reports more
  // cache reads than input tokens is clamped so billed input never goes
  // negative; the overlap is billed at the (cheaper) cached rate.
  const safeCacheReadTokens = Math.min(
    reportedCacheReadTokens,
    safeInputTokens,
  );
  if (safeCacheReadTokens !== reportedCacheReadTokens) {
    reportUsageCountAnomaly({
      modelId,
      field: "cacheReadTokens",
      value: cacheReadTokens,
    });
  }
  const rate = resolveModelRate(
    getModelRateOrFallback(modelId),
    safeInputTokens,
  );
  const billedInputTokens = safeInputTokens - safeCacheReadTokens;
  const cachedRate = rate.cachedInputPerMTok ?? rate.inputPerMTok;
  const inputCost = scaleTokenCost(billedInputTokens, rate.inputPerMTok);
  const cacheCost = scaleTokenCost(safeCacheReadTokens, cachedRate);
  const outputCost = scaleTokenCost(safeOutputTokens, rate.outputPerMTok);
  const rawUsageMicroUnits = inputCost + cacheCost + outputCost;
  if (!Number.isSafeInteger(rawUsageMicroUnits)) {
    panic("computed raw usage exceeds the safe integer range");
  }
  return rawUsageMicroUnits;
};

type UsageUnitsFromTokensInput = UsageInput & {
  actionType: UsageActionType;
  serviceTier: UsageServiceTier;
  isByok: boolean;
};

type UsageUnitsFromTokensResult = {
  rawUsageMicroUnits: number;
  unitsConsumed: number;
};

/**
 * The post-flight metering path: turn provider token usage into the two
 * fields the ledger needs (`raw_usage_micro_units`,
 * `units_consumed`). Use this from the analytics callback when the
 * actual token counts are known.
 * BYOK actions skip the consumption floor: the ledger still
 * records usage for attribution, but there is no platform-side
 * model spend to deduct.
 */
export const usageUnitsFromTokens = ({
  modelId,
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
  actionType,
  serviceTier,
  isByok,
}: UsageUnitsFromTokensInput): UsageUnitsFromTokensResult => {
  const rawUsageMicroUnits = computeRawUsageMicroUnits({
    modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
  });
  if (isByok) {
    return { rawUsageMicroUnits, unitsConsumed: 0 };
  }
  const tierMultiplier = SERVICE_TIER_MULTIPLIERS[serviceTier];
  const adjusted = Math.ceil(
    (rawUsageMicroUnits * tierMultiplier) / MICRO_UNITS_PER_USAGE_UNIT,
  );
  // Non-BYOK actions keep the existing action floor so tiny
  // calls still produce visible ledger rows.
  const actionFloor = computeUsageUnitCost({
    actionType,
    serviceTier,
    isByok: false,
  });
  return {
    rawUsageMicroUnits,
    unitsConsumed: Math.max(adjusted, actionFloor, ACTION_WEIGHTS[actionType]),
  };
};
