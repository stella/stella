/**
 * Per-model usage conversion for the usage ledger.
 *
 * This module converts actual provider usage (input / output /
 * cached tokens) into the ledger's normalized integer units. The
 * analytics callback in `lib/analytics/ai.ts` is the natural
 * caller because it receives `usage` from the AI SDK on every
 * `onStepFinish`.
 */

import { panic } from "better-result";

import { MODEL_RATES } from "@stll/ai-catalog";
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
 * Conservative default used for any model not in MODEL_RATES.
 * Picked above the typical low-tier model rate so unknown
 * models are attributed defensively rather than escaping the meter.
 */
const FALLBACK_RATE: ModelRate = {
  inputPerMTok: 500_000,
  outputPerMTok: 2_000_000,
};

const ONE_MILLION = 1_000_000;

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
 * model's public rate table. Caller is responsible for passing
 * non-negative integers; we trust the AI SDK's `usage` shape.
 */
export const computeRawUsageMicroUnits = ({
  modelId,
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
}: UsageInput): number => {
  if (
    inputTokens < 0 ||
    outputTokens < 0 ||
    cacheReadTokens < 0 ||
    cacheReadTokens > inputTokens
  ) {
    panic(
      "computeRawUsageMicroUnits got negative or inconsistent token counts",
    );
  }
  const rate = MODEL_RATES[modelId] ?? FALLBACK_RATE;
  const billedInputTokens = inputTokens - cacheReadTokens;
  const cachedRate = rate.cachedInputPerMTok ?? rate.inputPerMTok;
  const inputCost = Math.ceil(
    (billedInputTokens * rate.inputPerMTok) / ONE_MILLION,
  );
  const cacheCost = Math.ceil((cacheReadTokens * cachedRate) / ONE_MILLION);
  const outputCost = Math.ceil(
    (outputTokens * rate.outputPerMTok) / ONE_MILLION,
  );
  return inputCost + cacheCost + outputCost;
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
 * The post-flight metering path: turn AI SDK usage into the two
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
