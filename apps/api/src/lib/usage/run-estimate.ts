/**
 * Pre-flight sizing for document-scale runs.
 *
 * The initiator knows the pinned files' stored byte sizes and the
 * planned output count before any model call, so the estimate converts
 * those through the same rate table settlement uses, and adds the
 * per-call settlement floor for every planned generation. Each
 * heuristic is deliberately coarse and errs high — stored archives
 * inflate into larger prompts, and token units plus full floors bound
 * the per-call `max(tokens, floor)` settlement from above — because
 * the number gates a confirmation, it is not a charge.
 */

import type { UsageActionType, UsageServiceTier } from "@/api/db/schema";
import {
  computeUsageUnitCost,
  SERVICE_TIER_MULTIPLIERS,
} from "@/api/lib/usage/action-weights";
import {
  computeRawUsageMicroUnits,
  MICRO_UNITS_PER_USAGE_UNIT,
} from "@/api/lib/usage/unit-model";

/**
 * Prompt bytes assumed per stored byte. Stored documents are
 * compressed archives that inflate into serialized prompt blocks, so
 * the stored size understates what the model reads.
 */
const PROMPT_BYTES_PER_STORED_BYTE = 4;

/** Rough prompt bytes per model token. */
const BYTES_PER_TOKEN = 4;

/** Flat output budget assumed per planned item (finding, step result). */
const OUTPUT_TOKENS_PER_PLANNED_ITEM = 250;

type EstimateDocumentRunUnitsInput = {
  modelId: string;
  actionType: UsageActionType;
  storedInputBytes: number;
  plannedOutputs: number;
  serviceTier: UsageServiceTier;
};

export const estimateDocumentRunUnits = ({
  modelId,
  actionType,
  storedInputBytes,
  plannedOutputs,
  serviceTier,
}: EstimateDocumentRunUnitsInput): number => {
  const inputTokens = Math.ceil(
    (storedInputBytes * PROMPT_BYTES_PER_STORED_BYTE) / BYTES_PER_TOKEN,
  );
  const outputTokens = plannedOutputs * OUTPUT_TOKENS_PER_PLANNED_ITEM;
  const rawMicroUnits = computeRawUsageMicroUnits({
    modelId,
    outputTokens,
    uncachedInputTokens: inputTokens,
  });
  const tokenUnits = Math.ceil(
    (rawMicroUnits * SERVICE_TIER_MULTIPLIERS[serviceTier]) /
      MICRO_UNITS_PER_USAGE_UNIT,
  );
  // Settlement floors each generation separately; one shared pass plus
  // one generation per planned item bounds the call count.
  const plannedCalls = plannedOutputs + 1;
  const floorUnits =
    plannedCalls *
    computeUsageUnitCost({ actionType, serviceTier, isByok: false });
  return tokenUnits + floorUnits;
};

type EstimatePromptRunUnitsInput = {
  modelId: string;
  actionType: UsageActionType;
  /** Number of model calls the run will make. */
  plannedCalls: number;
  /** Upper bound on prompt bytes per call (the executor's own caps). */
  promptBytesPerCall: number;
  /** Upper bound on output tokens per call. */
  outputTokensPerCall: number;
  serviceTier: UsageServiceTier;
};

/**
 * Sizing for runs whose executor caps each prompt itself (flows: prior
 * step outputs and document context are both truncated to fixed
 * lengths), so the estimate is the cap times the call count, not a
 * guess from stored file sizes.
 */
export const estimatePromptRunUnits = ({
  modelId,
  actionType,
  plannedCalls,
  promptBytesPerCall,
  outputTokensPerCall,
  serviceTier,
}: EstimatePromptRunUnitsInput): number => {
  const rawMicroUnits = computeRawUsageMicroUnits({
    modelId,
    inputTokens: Math.ceil(promptBytesPerCall / BYTES_PER_TOKEN) * plannedCalls,
    outputTokens: outputTokensPerCall * plannedCalls,
  });
  const tokenUnits = Math.ceil(
    (rawMicroUnits * SERVICE_TIER_MULTIPLIERS[serviceTier]) /
      MICRO_UNITS_PER_USAGE_UNIT,
  );
  const floorUnits =
    plannedCalls *
    computeUsageUnitCost({ actionType, serviceTier, isByok: false });
  return tokenUnits + floorUnits;
};
