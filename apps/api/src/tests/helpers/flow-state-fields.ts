import { panic } from "better-result";

import type { FlowRunStatus, FlowRunStepStatus } from "@stll/api-contract";
import { createTestClock } from "@stll/test-kit";

const clock = createTestClock();

type StateFields = {
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
};

const ACTIVE_FIELDS = { finishedAt: null, error: null } as const;

/** Every state field of a flow run, as the flow engine writes that status. */
export const flowRunStateFields = (status: FlowRunStatus): StateFields => {
  const at = new Date(clock.now());
  switch (status) {
    case "pending":
      return { startedAt: null, ...ACTIVE_FIELDS };
    case "running":
    case "awaiting_review":
      return { startedAt: at, ...ACTIVE_FIELDS };
    case "completed":
    case "cancelled":
      return { startedAt: at, finishedAt: at, error: null };
    case "failed":
      return { startedAt: at, finishedAt: at, error: "Step failed" };
    default:
      status satisfies never;
      return panic("Unhandled flow run status");
  }
};

/** Every state field of a flow run step, as the flow engine writes it. */
export const flowRunStepStateFields = (
  status: FlowRunStepStatus,
): StateFields => {
  const at = new Date(clock.now());
  switch (status) {
    case "pending":
      return { startedAt: null, ...ACTIVE_FIELDS };
    case "running":
    case "awaiting_review":
      return { startedAt: at, ...ACTIVE_FIELDS };
    case "completed":
    case "skipped":
      return { startedAt: at, finishedAt: at, error: null };
    case "failed":
      return { startedAt: at, finishedAt: at, error: "Step failed" };
    default:
      status satisfies never;
      return panic("Unhandled flow run step status");
  }
};
