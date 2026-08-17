import { describe, expect, test } from "bun:test";

import { estimateFlowRunUnits } from "./flow-run-estimate";
import type { FlowStep } from "./flow-types";

const aiStep = (includeDocuments: boolean): FlowStep => ({
  kind: "ai",
  name: "Summarise",
  prompt: "Summarise the inputs.",
  includeDocuments,
});

const gateStep: FlowStep = {
  kind: "review-gate",
  name: "Approve",
  instructions: "Check the summary.",
};

describe("estimateFlowRunUnits", () => {
  test("a definition with no AI steps costs nothing", () => {
    expect(
      estimateFlowRunUnits({
        modelId: "gpt-5.6-luna",
        steps: [gateStep],
        inputEntityCount: 10,
      }),
    ).toBe(0);
  });

  test("documents count only when a step includes them", () => {
    const without = estimateFlowRunUnits({
      modelId: "gpt-5.6-luna",
      steps: [aiStep(false)],
      inputEntityCount: 10,
    });
    const withDocuments = estimateFlowRunUnits({
      modelId: "gpt-5.6-luna",
      steps: [aiStep(true)],
      inputEntityCount: 10,
    });
    expect(withDocuments).toBeGreaterThan(without);
  });

  test("grows with the AI-step count, and every step carries its floor", () => {
    const one = estimateFlowRunUnits({
      modelId: "gpt-5.6-luna",
      steps: [aiStep(false)],
      inputEntityCount: 0,
    });
    const three = estimateFlowRunUnits({
      modelId: "gpt-5.6-luna",
      steps: [aiStep(false), gateStep, aiStep(false), aiStep(false)],
      inputEntityCount: 0,
    });
    expect(three).toBeGreaterThan(one * 2);
    // Three background-tier floors (1 x 1.5, ceiled = 2 each) at minimum.
    expect(three).toBeGreaterThanOrEqual(6);
  });
});
