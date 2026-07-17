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

import type { TranslationKey } from "@/i18n/types";

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

export const LIST_ITEM_TYPES = [
  "task",
  "fact",
  "issue",
  "requirement",
  "event",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ListItemType = (typeof LIST_ITEM_TYPES)[number];

export const ITEM_TYPE_TRANSLATION_KEYS = {
  event: "common.itemTypeValues.event",
  fact: "common.itemTypeValues.fact",
  issue: "knowledge.playbooks.issueLabel",
  requirement: "common.itemTypeValues.requirement",
  task: "search.kinds.task",
} as const satisfies Record<ListItemType, TranslationKey>;

export const isTaskStatus = (v: string | null): v is TaskStatus =>
  v !== null && TASK_STATUSES.some((status) => status === v);

export const isTaskPriority = (v: string | null): v is TaskPriority =>
  v !== null && TASK_PRIORITIES.some((priority) => priority === v);

export const isListItemType = (
  value: string | null | undefined,
): value is ListItemType =>
  value !== null &&
  value !== undefined &&
  LIST_ITEM_TYPES.some((itemType) => itemType === value);

export const STATUS_ICONS = {
  open: CircleIcon,
  in_progress: CircleDotIcon,
  in_review: CircleDotIcon,
  done: CheckCircle2Icon,
  cancelled: XCircleIcon,
} as const satisfies Record<TaskStatus, typeof CircleIcon>;

export const STATUS_COLORS = {
  open: "text-muted-foreground",
  in_progress: "text-foreground dark:text-foreground-muted",
  in_review: "text-warning",
  done: "text-success dark:text-success",
  cancelled: "text-destructive dark:text-destructive",
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
  urgent: "text-destructive",
  high: "text-warning",
  medium: "text-warning",
  low: "text-foreground-muted dark:text-foreground",
} as const satisfies Record<TaskPriority, string>;
