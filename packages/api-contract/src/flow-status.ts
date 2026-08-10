export const FLOW_RUN_STATUSES = [
  "pending",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
] as const;

export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export const FLOW_RUN_STEP_STATUSES = [
  "pending",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "skipped",
] as const;

export type FlowRunStepStatus = (typeof FLOW_RUN_STEP_STATUSES)[number];

export const FLOW_STEP_KINDS = [
  "ai",
  "review-gate",
  "create-document",
] as const;

export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number];

export const FLOW_TRIGGER_TYPES = [
  "manual",
  "schedule",
  "file-upload",
] as const;

export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number];

export const FLOW_SCHEDULE_FREQUENCIES = [
  "daily",
  "weekly",
  "monthly",
] as const;

export type FlowScheduleFrequency = (typeof FLOW_SCHEDULE_FREQUENCIES)[number];

const FLOW_RUN_STATUS_LIFECYCLE = {
  pending: "active",
  running: "active",
  awaiting_review: "active",
  completed: "terminal",
  failed: "terminal",
  cancelled: "terminal",
} as const satisfies Record<FlowRunStatus, "active" | "terminal">;

export type TerminalFlowRunStatus = {
  [TStatus in FlowRunStatus]: (typeof FLOW_RUN_STATUS_LIFECYCLE)[TStatus] extends "terminal"
    ? TStatus
    : never;
}[FlowRunStatus];

export const isTerminalFlowRunStatus = (
  status: FlowRunStatus,
): status is TerminalFlowRunStatus =>
  FLOW_RUN_STATUS_LIFECYCLE[status] === "terminal";

export const FLOW_RUN_TERMINAL_STATUSES = FLOW_RUN_STATUSES.filter(
  isTerminalFlowRunStatus,
);
