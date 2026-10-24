import {
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  XCircleIcon,
} from "@stll/ui/icons";
import type { LucideIcon } from "@stll/ui/icons";

/**
 * How a task's status is drawn: one glyph and one colour per status.
 *
 * Owned here so every surface that draws a task (the app's boards and tables,
 * the published feature previews) reads the same mapping. The status union
 * itself belongs to the API contract; its consumer binds these maps to it with
 * `satisfies Record<TaskStatus, …>`, so a status added there fails typecheck
 * until it has a glyph here.
 */
export const TASK_STATUS_ICONS: Record<
  "open" | "in_progress" | "in_review" | "done" | "cancelled",
  LucideIcon
> = {
  open: CircleIcon,
  in_progress: CircleDotIcon,
  in_review: CircleDotIcon,
  done: CheckCircle2Icon,
  cancelled: XCircleIcon,
};

export const TASK_STATUS_COLORS = {
  open: "text-muted-foreground",
  in_progress: "text-foreground dark:text-foreground-muted",
  in_review: "text-warning",
  done: "text-success dark:text-success",
  cancelled: "text-destructive dark:text-destructive",
} as const satisfies Record<keyof typeof TASK_STATUS_ICONS, string>;

export type TaskStatusGlyph = keyof typeof TASK_STATUS_ICONS;
