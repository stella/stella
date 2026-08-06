/**
 * The option sets an entity's own columns range over, declared once.
 *
 * `entities.status` and `entities.priority` are plain varchar columns: the
 * database constrains neither, so every consumer that enumerates them (the
 * kanban columns, the grouped-count SQL, the filter dropdowns, the status
 * icons) is interpreting an unconstrained string. Each of those used to
 * carry its own copy of the list, bound to nothing, so a new status reached
 * exactly none of them: rows would group into a column that does not exist
 * and drop out of the counts.
 *
 * Declaration order is display order. The kanban board, the filter menu and
 * the grouped counts all render these in the order given here.
 */
export const TASK_STATUS = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TASK_STATUSES = Object.values(TASK_STATUS);

export const isTaskStatus = (value: unknown): value is TaskStatus =>
  typeof value === "string" && TASK_STATUSES.some((status) => status === value);

export const ENTITY_PRIORITY = {
  NONE: "none",
  URGENT: "urgent",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export type EntityPriority =
  (typeof ENTITY_PRIORITY)[keyof typeof ENTITY_PRIORITY];

export const ENTITY_PRIORITIES = Object.values(ENTITY_PRIORITY);

export const isEntityPriority = (value: unknown): value is EntityPriority =>
  typeof value === "string" &&
  ENTITY_PRIORITIES.some((priority) => priority === value);
