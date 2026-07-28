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

/**
 * Convert token usage into normalized micro-units using the
 * model's public rate table. Provider token counts are validated here because
 * this helper is the shared boundary before usage reaches the ledger.
 */
export const computeRawUsageMicroUnits = ({
  modelId,
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
}: UsageInput): number => {
  if (
    !isNonNegativeSafeInteger(inputTokens) ||
    !isNonNegativeSafeInteger(outputTokens) ||
    !isNonNegativeSafeInteger(cacheReadTokens)
  ) {
    panic("usage token counts must be non-negative safe integers");
  }
  if (cacheReadTokens > inputTokens) {
    panic("cached input tokens cannot exceed total input tokens");
  }
  const rate = resolveModelRate(
    getModelRate(modelId) ?? FALLBACK_RATE,
    inputTokens,
  );
  const billedInputTokens = inputTokens - cacheReadTokens;
  const cachedRate = rate.cachedInputPerMTok ?? rate.inputPerMTok;
  const inputCost = scaleTokenCost(billedInputTokens, rate.inputPerMTok);
  const cacheCost = scaleTokenCost(cacheReadTokens, cachedRate);
  const outputCost = scaleTokenCost(outputTokens, rate.outputPerMTok);
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
