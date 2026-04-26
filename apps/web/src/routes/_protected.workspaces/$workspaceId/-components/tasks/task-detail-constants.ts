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

const TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

export const isTaskStatus = (v: string | null): v is TaskStatus =>
  v !== null && TASK_STATUS_SET.has(v);

const TASK_PRIORITY_SET: ReadonlySet<string> = new Set(TASK_PRIORITIES);

export const isTaskPriority = (v: string | null): v is TaskPriority =>
  v !== null && TASK_PRIORITY_SET.has(v);

export const STATUS_ICONS = {
  open: CircleIcon,
  in_progress: CircleDotIcon,
  in_review: CircleDotIcon,
  done: CheckCircle2Icon,
  cancelled: XCircleIcon,
} as const satisfies Record<TaskStatus, typeof CircleIcon>;

export const STATUS_COLORS = {
  open: "text-muted-foreground",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  in_progress: "text-blue-500 dark:text-blue-400",
  in_review: "text-amber-500",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  done: "text-green-500 dark:text-green-400",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  cancelled: "text-red-400 dark:text-red-300",
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
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  urgent: "text-red-500 dark:text-red-400",
  high: "text-orange-500",
  medium: "text-yellow-500",
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- dark: variant present; rule false positive
  low: "text-blue-400 dark:text-blue-300",
} as const satisfies Record<TaskPriority, string>;
