/**
 * Pre-flight sizing for document-scale runs.
 *
 * The initiator knows the pinned files' byte sizes and the planned
 * output count before any model call, so the estimate converts those
 * through the same rate table settlement uses. The heuristics are
 * deliberately coarse (bytes to tokens, a flat output budget per
 * planned item): the number gates a confirmation, it is not a charge.
 */

import type { UsageServiceTier } from "@/api/db/schema";
import { SERVICE_TIER_MULTIPLIERS } from "@/api/lib/usage/action-weights";
import {
  computeRawUsageMicroUnits,
  MICRO_UNITS_PER_USAGE_UNIT,
} from "@/api/lib/usage/unit-model";

/** Rough document bytes per model token (DOCX/PDF extracted text). */
const BYTES_PER_TOKEN = 4;

/** Flat output budget assumed per planned item (finding, step result). */
const OUTPUT_TOKENS_PER_PLANNED_ITEM = 250;

type EstimateDocumentRunUnitsInput = {
  modelId: string;
  inputBytes: number;
  plannedOutputs: number;
  serviceTier: UsageServiceTier;
};

export const estimateDocumentRunUnits = ({
  modelId,
  inputBytes,
  plannedOutputs,
  serviceTier,
}: EstimateDocumentRunUnitsInput): number => {
  const inputTokens = Math.ceil(inputBytes / BYTES_PER_TOKEN);
  const outputTokens = plannedOutputs * OUTPUT_TOKENS_PER_PLANNED_ITEM;
  const rawMicroUnits = computeRawUsageMicroUnits({
    modelId,
    inputTokens,
    outputTokens,
  });
  return Math.ceil(
    (rawMicroUnits * SERVICE_TIER_MULTIPLIERS[serviceTier]) /
      MICRO_UNITS_PER_USAGE_UNIT,
  );
};
