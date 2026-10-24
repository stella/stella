import {
  ENTITY_PRIORITIES as TASK_PRIORITIES,
  isEntityPriority as isTaskPriority,
  isTaskStatus,
  TASK_STATUSES,
} from "@stll/api-contract";
import type {
  EntityPriority as TaskPriority,
  TaskStatus,
} from "@stll/api-contract";
import {
  isListItemType,
  LIST_ITEM_TYPES,
} from "@stll/api-contract/entity-options";
import type { ListItemType } from "@stll/api-contract/entity-options";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  MinusIcon,
} from "@stll/ui/icons";
import type { OptionColor } from "@stll/ui/option-color";
import {
  TASK_STATUS_COLORS,
  TASK_STATUS_ICONS,
} from "@stll/workspace-ui/task-status";

import type { TranslationKey } from "@/i18n/types";

export {
  isListItemType,
  isTaskPriority,
  isTaskStatus,
  LIST_ITEM_TYPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
};
export type { ListItemType, TaskPriority, TaskStatus };

/** The YYYY-MM-DD part of a serialized date, or "" when absent. */
export const toISODate = (v: string | null | undefined): string =>
  v === null || v === undefined ? "" : v.slice(0, 10);

export const ITEM_TYPE_TRANSLATION_KEYS = {
  event: "common.itemTypeValues.event",
  fact: "common.fact",
  issue: "knowledge.playbooks.issueLabel",
  requirement: "common.itemTypeValues.requirement",
  task: "search.kinds.task",
} as const satisfies Record<ListItemType, TranslationKey>;

export const TASK_STATUS_OPTION_COLORS = {
  open: "gray",
  in_progress: "blue",
  in_review: "amber",
  done: "green",
  cancelled: "red",
} as const satisfies Record<TaskStatus, OptionColor>;

// The glyphs live in the shared package so the published feature previews
// draw tasks exactly as the app does; binding them to the API's status union
// here fails typecheck when a status has no glyph.
export const STATUS_ICONS = TASK_STATUS_ICONS satisfies Record<
  TaskStatus,
  typeof MinusIcon
>;

export const STATUS_COLORS = TASK_STATUS_COLORS satisfies Record<
  TaskStatus,
  string
>;

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

export const WORK_TYPES = ["task", "deadline"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
