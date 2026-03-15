import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  MinusIcon,
  XCircleIcon,
} from "lucide-react";

/** Normalize a date value that may be a Date object (Eden
 *  transforms `format: "date"`) or a YYYY-MM-DD string. */
export const toISODate = (v: string | Date | null | undefined): string => {
  if (v === null || v === undefined) {
    return "";
  }
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "string" && v.length === 10) {
    return v;
  }
  return v.slice(0, 10);
};

export const TASK_STATUSES = [
  "open",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

export const TASK_PRIORITIES = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const isTaskStatus = (v: string | null): v is TaskStatus =>
  v !== null && (TASK_STATUSES as readonly string[]).includes(v);

export const isTaskPriority = (v: string | null): v is TaskPriority =>
  v !== null && (TASK_PRIORITIES as readonly string[]).includes(v);

export const STATUS_ICONS = {
  open: CircleIcon,
  in_progress: CircleDotIcon,
  in_review: CircleDotIcon,
  done: CheckCircle2Icon,
  cancelled: XCircleIcon,
} as const satisfies Record<TaskStatus, typeof CircleIcon>;

export const STATUS_COLORS = {
  open: "text-muted-foreground",
  in_progress: "text-blue-500",
  in_review: "text-amber-500",
  done: "text-green-500",
  cancelled: "text-red-400",
} as const satisfies Record<TaskStatus, string>;

export const PRIORITY_ICONS = {
  none: MinusIcon,
  urgent: AlertCircleIcon,
  high: ArrowUpIcon,
  medium: MinusIcon,
  low: ArrowDownIcon,
} as const satisfies Record<TaskPriority, typeof MinusIcon>;

export const PRIORITY_COLORS = {
  none: "text-muted-foreground",
  urgent: "text-red-500",
  high: "text-orange-500",
  medium: "text-yellow-500",
  low: "text-blue-400",
} as const satisfies Record<TaskPriority, string>;
