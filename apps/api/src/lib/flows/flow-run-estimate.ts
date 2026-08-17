/**
 * Pre-flight sizing for a flow run, from the definition's steps and the
 * input document count. Each AI step's prompt is bounded by the
 * executor's own caps (prior outputs and documents are truncated to
 * fixed character lengths before they reach the model) and its output
 * by an enforced token cap, so the estimate is a true upper bound on
 * what the run can consume, times the AI-step count.
 */

import {
  FLOW_AI_STEP_MAX_OUTPUT_TOKENS,
  FLOW_DOCUMENT_CONTEXT_CHAR_CAP,
  FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP,
} from "@/api/lib/flows/flow-types";
import type { FlowStep } from "@/api/lib/flows/flow-types";
import { estimatePromptRunUnits } from "@/api/lib/usage/run-estimate";

/**
 * Worst-case characters per model token. Latin prose runs near four,
 * but token-dense scripts (CJK, some emoji sequences) approach one, so
 * the bound assumes one token per capped character rather than a
 * byte-based average that would under-count international input.
 */
const MIN_CHARS_PER_TOKEN = 1;

type EstimateFlowRunUnitsInput = {
  modelId: string;
  steps: readonly FlowStep[];
  inputEntityCount: number;
};

export const estimateFlowRunUnits = ({
  modelId,
  steps,
  inputEntityCount,
}: EstimateFlowRunUnitsInput): number => {
  const aiSteps = steps.filter((step) => step.kind === "ai");
  if (aiSteps.length === 0) {
    return 0;
  }
  const includesDocuments = aiSteps.some((step) => step.includeDocuments);
  // Every prior AI output can be replayed into a later step, and each
  // document is capped independently.
  const promptCharsPerCall =
    aiSteps.length * FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP +
    (includesDocuments ? inputEntityCount * FLOW_DOCUMENT_CONTEXT_CHAR_CAP : 0);
  return estimatePromptRunUnits({
    modelId,
    actionType: "background",
    plannedCalls: aiSteps.length,
    inputTokensPerCall: Math.ceil(promptCharsPerCall / MIN_CHARS_PER_TOKEN),
    outputTokensPerCall: FLOW_AI_STEP_MAX_OUTPUT_TOKENS,
    serviceTier: "standard",
  });
};
