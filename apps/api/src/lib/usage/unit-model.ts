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
import type { AIProvider, ModelRate } from "@stll/ai-catalog";

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

/**
 * Highest token count the meter accepts per component: far above any real
 * context window, and low enough that every downstream product with a
 * catalog rate stays inside the safe-integer range.
 */
const MAX_TOKEN_COUNT = 2 ** 40;

// Usage shape anomalies already reported this process, keyed by model id
// and anomaly, so a systematically malformed provider response cannot spam
// telemetry on the hot metering path.
const reportedUsageShapeAnomalies = new Set<string>();

type UsageShapeAnomalyOptions = {
  modelId: string;
  anomaly: string;
  context: Record<string, string>;
};

const reportUsageShapeAnomaly = ({
  modelId,
  anomaly,
  context,
}: UsageShapeAnomalyOptions): void => {
  const key = `${modelId}:${anomaly}`;
  if (reportedUsageShapeAnomalies.has(key)) {
    return;
  }
  reportedUsageShapeAnomalies.add(key);
  captureError(
    new TelemetryError({
      message: `Provider usage shape anomaly (${anomaly}); metering fell back to a conservative value`,
    }),
    { source: "usage-unit-model", modelId, anomaly, ...context },
  );
};

type SanitizeTokenCountOptions = {
  modelId: string;
  field: string;
  value: number;
};

/**
 * Provider-reported token counts are external input, so a malformed count
 * is an expected runtime failure, never a process-fatal invariant. Coerce
 * out-of-domain values to the nearest conservative in-domain value and
 * report the raw shape: non-finite and negative counts meter as 0,
 * fractional counts round up, oversized counts clamp to `MAX_TOKEN_COUNT`.
 */
const sanitizeTokenCount = ({
  modelId,
  field,
  value,
}: SanitizeTokenCountOptions): number => {
  if (isNonNegativeSafeInteger(value) && value <= MAX_TOKEN_COUNT) {
    return value;
  }
  reportUsageShapeAnomaly({
    modelId,
    anomaly: `invalid-${field}`,
    context: { value: String(value) },
  });
  if (Number.isNaN(value) || value <= 0) {
    return 0;
  }
  // Oversized positive values (finite or +Infinity) clamp to the ceiling
  // rather than zeroing: a too-large count must never under-meter.
  return Math.min(Math.ceil(value), MAX_TOKEN_COUNT);
};

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

type CacheAccounting = "included-in-input" | "separate-from-input";

/**
 * How each provider's reported input/prompt token count relates to its
 * cache-read count. OpenAI-style usage reports cached tokens as a subset
 * of the prompt count (`prompt_tokens_details.cached_tokens` within
 * `prompt_tokens`); Gemini's `promptTokenCount` likewise includes
 * `cachedContentTokenCount`. Anthropic-style usage reports `input_tokens`
 * EXCLUDING `cache_read_input_tokens` and `cache_creation_input_tokens`,
 * so on a warm cache the cached count legitimately exceeds the input
 * count; Bedrock's Converse usage follows the same split.
 */
const PROVIDER_CACHE_ACCOUNTING = {
  anthropic: "separate-from-input",
  azure_foundry: "included-in-input",
  bedrock: "separate-from-input",
  google: "included-in-input",
  huggingface: "included-in-input",
  mistral: "included-in-input",
  openai: "included-in-input",
  openai_compatible: "included-in-input",
  openrouter: "included-in-input",
} as const satisfies Record<AIProvider, CacheAccounting>;

type NormalizeProviderPromptTokensOptions = {
  provider: AIProvider;
  modelId: string;
  /** The provider's own input/prompt token count, in its native semantics. */
  promptTokens: number;
  /** The provider's cache-read count, in its native semantics. */
  cacheReadTokens: number;
  /** Cache-write (cache creation) count for providers that report one. */
  cacheWriteTokens: number;
};

type NormalizedPromptTokens = {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * Normalize a provider's native prompt-token accounting into the
 * non-overlapping components the unit model bills: uncached input at the
 * full input rate, cache reads at the cache-read rate, and cache writes at
 * the cache-write rate. This is the only place provider cache semantics may
 * be interpreted; downstream code
 * never subtracts one provider-reported count from another.
 */
export const normalizeProviderPromptTokens = ({
  provider,
  modelId,
  promptTokens,
  cacheReadTokens,
  cacheWriteTokens,
}: NormalizeProviderPromptTokensOptions): NormalizedPromptTokens => {
  const prompt = sanitizeTokenCount({
    modelId,
    field: "promptTokens",
    value: promptTokens,
  });
  const cacheRead = sanitizeTokenCount({
    modelId,
    field: "cacheReadTokens",
    value: cacheReadTokens,
  });
  const cacheWrite = sanitizeTokenCount({
    modelId,
    field: "cacheWriteTokens",
    value: cacheWriteTokens,
  });
  const accounting = PROVIDER_CACHE_ACCOUNTING[provider];
  switch (accounting) {
    case "separate-from-input":
      return {
        uncachedInputTokens: prompt,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      };
    case "included-in-input": {
      const cachedTokens = cacheRead + cacheWrite;
      if (cachedTokens > prompt) {
        // Under subset semantics the cached count can never exceed the
        // prompt count: a shape disagreement with the provider, not an
        // internal invariant. Fall back to separate accounting — bill the
        // full prompt at the input rate AND the reported cache operations at
        // their rates. That over-meters relative to either consistent reading,
        // which is the conservative direction; discarding the larger cache
        // count would under-meter.
        reportUsageShapeAnomaly({
          modelId,
          anomaly: "cache-tokens-exceed-included-prompt",
          context: {
            provider,
            promptTokens: String(prompt),
            cacheReadTokens: String(cacheRead),
            cacheWriteTokens: String(cacheWrite),
          },
        });
        return {
          uncachedInputTokens: prompt,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        };
      }
      return {
        uncachedInputTokens: prompt - cachedTokens,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
      };
    }
    default: {
      accounting satisfies never;
      return panic(`Unhandled accounting: ${String(accounting)}`);
    }
  }
};

type UsageInput = {
  modelId: string;
  /**
   * Input tokens billed at the full input rate. Excludes cache reads/writes:
   * provider usage must pass through `normalizeProviderPromptTokens`
   * first, never a raw provider prompt total.
   */
  uncachedInputTokens: number;
  outputTokens: number;
  /**
   * Tokens that were served from the provider's prompt cache, disjoint
   * from `uncachedInputTokens`. Where the model offers a cache adjustment
   * we count these at `cachedInputPerMTok`; otherwise they're treated as
   * normal input tokens. Defaults to 0.
   */
  cacheReadTokens?: number;
  /** Tokens written to the provider's prompt cache. Defaults to 0. */
  cacheWriteTokens?: number;
};

/**
 * Convert token usage into normalized micro-units using the
 * model's public rate table. Provider token counts are sanitized here
 * because this helper is the shared boundary before usage reaches the
 * ledger; a malformed count meters conservatively and reports telemetry
 * instead of failing.
 */
export const computeRawUsageMicroUnits = ({
  modelId,
  uncachedInputTokens,
  outputTokens,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
}: UsageInput): number => {
  const uncachedInput = sanitizeTokenCount({
    modelId,
    field: "uncachedInputTokens",
    value: uncachedInputTokens,
  });
  const output = sanitizeTokenCount({
    modelId,
    field: "outputTokens",
    value: outputTokens,
  });
  const cacheRead = sanitizeTokenCount({
    modelId,
    field: "cacheReadTokens",
    value: cacheReadTokens,
  });
  const cacheWrite = sanitizeTokenCount({
    modelId,
    field: "cacheWriteTokens",
    value: cacheWriteTokens,
  });
  // Long-context rate tiers key on what the model actually read, so tier
  // resolution counts cached prompt tokens too.
  const totalInputTokens = uncachedInput + cacheRead + cacheWrite;
  const rate = resolveModelRate(
    getModelRateOrFallback(modelId),
    totalInputTokens,
  );
  const cachedRate = rate.cachedInputPerMTok ?? rate.inputPerMTok;
  const cachedWriteRate = rate.cachedWriteInputPerMTok ?? rate.inputPerMTok;
  const inputCost = scaleTokenCost(uncachedInput, rate.inputPerMTok);
  const cacheCost = scaleTokenCost(cacheRead, cachedRate);
  const cacheWriteCost = scaleTokenCost(cacheWrite, cachedWriteRate);
  const outputCost = scaleTokenCost(output, rate.outputPerMTok);
  const rawUsageMicroUnits =
    inputCost + cacheCost + cacheWriteCost + outputCost;
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
  uncachedInputTokens,
  outputTokens,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  actionType,
  serviceTier,
  isByok,
}: UsageUnitsFromTokensInput): UsageUnitsFromTokensResult => {
  const rawUsageMicroUnits = computeRawUsageMicroUnits({
    modelId,
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
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
