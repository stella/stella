import {
  ClockIcon,
  FilePlus2Icon,
  UploadIcon,
  UserCheckIcon,
  WandSparklesIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

import {
  FLOW_RUN_STATUSES,
  FLOW_RUN_STEP_STATUSES,
  FLOW_RUN_TERMINAL_STATUSES,
  FLOW_SCHEDULE_FREQUENCIES,
  FLOW_STEP_KINDS,
  FLOW_TRIGGER_TYPES,
  isTerminalFlowRunStatus,
  type FlowRunStatus,
  type FlowRunStepStatus,
  type FlowScheduleFrequency,
  type FlowStepKind,
  type FlowTriggerType,
} from "@stll/api-contract";

import type { TranslationKey } from "@/i18n/types";

export {
  FLOW_RUN_STATUSES,
  FLOW_RUN_TERMINAL_STATUSES,
  FLOW_SCHEDULE_FREQUENCIES,
  FLOW_STEP_KINDS,
  FLOW_TRIGGER_TYPES,
  isTerminalFlowRunStatus,
};
export type {
  FlowRunStatus,
  FlowScheduleFrequency,
  FlowStepKind,
  FlowTriggerType,
};

export const FLOW_STEP_STATUSES = FLOW_RUN_STEP_STATUSES;
export type FlowStepStatus = FlowRunStepStatus;

// -- Label + icon maps (typed against TranslationKey so a stale key fails
//    typecheck) --

export const FLOW_STEP_KIND_LABEL_KEYS = {
  ai: "flows.steps.ai",
  "review-gate": "flows.steps.reviewGate",
  "create-document": "flows.steps.createDocument",
} as const satisfies Record<FlowStepKind, TranslationKey>;

export const FLOW_STEP_KIND_ICONS = {
  ai: WandSparklesIcon,
  "review-gate": UserCheckIcon,
  "create-document": FilePlus2Icon,
} as const satisfies Record<FlowStepKind, LucideIcon>;

export const FLOW_STEP_KIND_HELP_KEYS = {
  ai: "flows.steps.aiHelp",
  "review-gate": "flows.steps.reviewGateHelp",
  "create-document": "flows.steps.createDocumentHelp",
} as const satisfies Record<FlowStepKind, TranslationKey>;

export const FLOW_TRIGGER_TYPE_LABEL_KEYS = {
  manual: "flows.trigger.manual",
  schedule: "flows.trigger.schedule",
  "file-upload": "flows.trigger.fileUpload",
} as const satisfies Record<FlowTriggerType, TranslationKey>;

export const FLOW_TRIGGER_TYPE_ICONS = {
  manual: ZapIcon,
  schedule: ClockIcon,
  "file-upload": UploadIcon,
} as const satisfies Record<FlowTriggerType, LucideIcon>;

export const FLOW_SCHEDULE_FREQUENCY_LABEL_KEYS = {
  daily: "flows.schedule.daily",
  weekly: "flows.schedule.weekly",
  monthly: "flows.schedule.monthly",
} as const satisfies Record<FlowScheduleFrequency, TranslationKey>;

export const FLOW_RUN_STATUS_LABEL_KEYS = {
  pending: "flows.status.pending",
  running: "flows.status.running",
  awaiting_review: "flows.status.awaitingReview",
  completed: "flows.status.completed",
  failed: "flows.status.failed",
  cancelled: "flows.status.cancelled",
} as const satisfies Record<FlowRunStatus, TranslationKey>;

export const FLOW_STEP_STATUS_LABEL_KEYS = {
  pending: "flows.status.pending",
  running: "flows.status.running",
  awaiting_review: "flows.status.awaitingReview",
  completed: "flows.status.completed",
  failed: "flows.status.failed",
  skipped: "flows.status.skipped",
} as const satisfies Record<FlowStepStatus, TranslationKey>;

// Shared status → token classes. Superset covering both run and step statuses
// so the badge renders any status. Uses the semantic option-* colour tokens
// (same palette as invoice-status-badge).
export const FLOW_STATUS_STYLES = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-[var(--option-blue-bg)] text-[var(--option-blue-fg)]",
  awaiting_review: "bg-[var(--option-amber-bg)] text-[var(--option-amber-fg)]",
  completed: "bg-[var(--option-emerald-bg)] text-[var(--option-emerald-fg)]",
  failed: "bg-[var(--option-red-bg)] text-[var(--option-red-fg)]",
  cancelled: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
} as const satisfies Record<FlowRunStatus | FlowStepStatus, string>;
