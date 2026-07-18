import { describe, expect, test } from "bun:test";

import {
  advanceAfterStep,
  canCancelFlowRun,
  canReviewFlowRun,
  isTerminalFlowRunStatus,
  resolveReviewGateTransition,
} from "@/api/lib/flows/flow-run-transitions";

describe("advanceAfterStep", () => {
  test("finishes the run when the last step completes", () => {
    expect(advanceAfterStep({ stepIndex: 2, stepCount: 3 })).toEqual({
      kind: "finish",
    });
  });

  test("advances to the next index for a non-final step", () => {
    expect(advanceAfterStep({ stepIndex: 0, stepCount: 3 })).toEqual({
      kind: "advance",
      nextStepIndex: 1,
    });
  });

  test("a single-step run finishes after step 0", () => {
    expect(advanceAfterStep({ stepIndex: 0, stepCount: 1 })).toEqual({
      kind: "finish",
    });
  });
});

describe("resolveReviewGateTransition", () => {
  test("rejection cancels the run regardless of position", () => {
    expect(
      resolveReviewGateTransition({
        decision: "rejected",
        stepIndex: 0,
        stepCount: 5,
      }),
    ).toEqual({ kind: "cancel" });
  });

  test("approval of a middle gate advances to the next step", () => {
    expect(
      resolveReviewGateTransition({
        decision: "approved",
        stepIndex: 1,
        stepCount: 3,
      }),
    ).toEqual({ kind: "advance", nextStepIndex: 2 });
  });

  test("approval of the final gate finishes the run", () => {
    expect(
      resolveReviewGateTransition({
        decision: "approved",
        stepIndex: 2,
        stepCount: 3,
      }),
    ).toEqual({ kind: "finish" });
  });
});

describe("run-status guards", () => {
  test("terminal statuses are recognized", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      expect(isTerminalFlowRunStatus(status)).toBe(true);
    }
    for (const status of ["pending", "running", "awaiting_review"] as const) {
      expect(isTerminalFlowRunStatus(status)).toBe(false);
    }
  });

  test("cancel is allowed only while non-terminal", () => {
    expect(canCancelFlowRun("pending")).toBe(true);
    expect(canCancelFlowRun("running")).toBe(true);
    expect(canCancelFlowRun("awaiting_review")).toBe(true);
    expect(canCancelFlowRun("completed")).toBe(false);
    expect(canCancelFlowRun("failed")).toBe(false);
    expect(canCancelFlowRun("cancelled")).toBe(false);
  });

  test("review is allowed only while awaiting review", () => {
    expect(canReviewFlowRun("awaiting_review")).toBe(true);
    expect(canReviewFlowRun("running")).toBe(false);
    expect(canReviewFlowRun("pending")).toBe(false);
    expect(canReviewFlowRun("completed")).toBe(false);
  });
});
