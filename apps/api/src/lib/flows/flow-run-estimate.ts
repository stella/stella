/**
 * Pre-flight sizing for a flow run, from the definition's steps and the
 * input document count. Each AI step's prompt is bounded by the
 * executor's own caps (prior outputs and documents are truncated to
 * fixed lengths before they reach the model), so the estimate is a true
 * upper bound on prompt size times the AI-step count.
 */

import {
  FLOW_DOCUMENT_CONTEXT_CHAR_CAP,
  FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP,
} from "@/api/lib/flows/flow-types";
import type { FlowStep } from "@/api/lib/flows/flow-types";
import { estimatePromptRunUnits } from "@/api/lib/usage/run-estimate";

/** Output budget assumed per AI step (a markdown section, capped later
 *  by the executor's context cap when fed to the next step). */
const OUTPUT_TOKENS_PER_AI_STEP = 2000;

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
  // document is capped independently; both are chars, which the
  // estimator treats as prompt bytes.
  const promptBytesPerCall =
    aiSteps.length * FLOW_STEP_OUTPUT_CONTEXT_CHAR_CAP +
    (includesDocuments ? inputEntityCount * FLOW_DOCUMENT_CONTEXT_CHAR_CAP : 0);
  return estimatePromptRunUnits({
    modelId,
    actionType: "background",
    plannedCalls: aiSteps.length,
    promptBytesPerCall,
    outputTokensPerCall: OUTPUT_TOKENS_PER_AI_STEP,
    serviceTier: "standard",
  });
};
