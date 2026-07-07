import {
  ClockIcon,
  FilePlus2Icon,
  UploadIcon,
  UserCheckIcon,
  WandSparklesIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

import type { TranslationKey } from "@/i18n/types";

// Domain value unions for the Workflows (internal: "flow") feature. Kept as
// local `as const` lists (no TS enums) so the presentational layer does not
// depend on the workspace/knowledge route trees. They mirror the server unions
// in `apps/api/src/lib/flows/flow-types.ts`.

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

export const FLOW_RUN_STATUSES = [
  "pending",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "cancelled",
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export const FLOW_STEP_STATUSES = [
  "pending",
  "running",
  "awaiting_review",
  "completed",
  "failed",
  "skipped",
] as const;
export type FlowStepStatus = (typeof FLOW_STEP_STATUSES)[number];

// A run is terminal when no further transitions are possible; the runs list
// polls only while at least one run is non-terminal.
export const FLOW_RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;

export const isTerminalFlowRunStatus = (status: FlowRunStatus): boolean =>
  (FLOW_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);

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
