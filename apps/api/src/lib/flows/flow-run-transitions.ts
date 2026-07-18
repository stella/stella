import type {
  FlowReviewDecision,
  FlowRunStatus,
} from "@/api/lib/flows/flow-types";

/**
 * Pure status-transition logic for the flow run engine. Given a run's
 * position (current step index + total step count) and an event
 * (a step finished, or a reviewer decided), it computes the resulting
 * enqueue decision and terminal-ness. Kept free of DB/queue/IO so the
 * state machine is unit-testable in isolation from BullMQ and Postgres.
 */

/** Run statuses from which no further transition is possible. */
export const FLOW_TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export const isTerminalFlowRunStatus = (status: FlowRunStatus): boolean =>
  FLOW_TERMINAL_RUN_STATUSES.some((terminal) => terminal === status);

/**
 * What to do once a non-gate step (`ai` / `create-document`) completes, or
 * once a review gate is approved: either the run has finished (that was the
 * last step) or the next step must be enqueued.
 */
export type FlowStepAdvance =
  | { kind: "finish" }
  | { kind: "advance"; nextStepIndex: number };

export const advanceAfterStep = ({
  stepIndex,
  stepCount,
}: {
  stepIndex: number;
  stepCount: number;
}): FlowStepAdvance => {
  const nextStepIndex = stepIndex + 1;
  if (nextStepIndex >= stepCount) {
    return { kind: "finish" };
  }
  return { kind: "advance", nextStepIndex };
};

/**
 * Outcome of resolving a review gate. A rejection cancels the whole run; an
 * approval behaves exactly like a completed step (finish or advance).
 */
export type FlowReviewResolution = { kind: "cancel" } | FlowStepAdvance;

export const resolveReviewGateTransition = ({
  decision,
  stepIndex,
  stepCount,
}: {
  decision: FlowReviewDecision;
  stepIndex: number;
  stepCount: number;
}): FlowReviewResolution => {
  if (decision === "rejected") {
    return { kind: "cancel" };
  }
  return advanceAfterStep({ stepIndex, stepCount });
};

/** A run may be cancelled only while it is still in a non-terminal state. */
export const canCancelFlowRun = (status: FlowRunStatus): boolean =>
  status === "pending" || status === "running" || status === "awaiting_review";

/** A review may be resolved only while the run is paused at a gate. */
export const canReviewFlowRun = (status: FlowRunStatus): boolean =>
  status === "awaiting_review";
