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

// Frozen and typed readonly: this is the one declaration every consumer
// reads, so a stray `.push()` or in-place `.sort()` would reorder the kanban
// columns and the filter menus everywhere at once.
export const TASK_STATUSES: readonly TaskStatus[] = Object.freeze(
  Object.values(TASK_STATUS),
);

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

export const ENTITY_PRIORITIES: readonly EntityPriority[] = Object.freeze(
  Object.values(ENTITY_PRIORITY),
);

export const isEntityPriority = (value: unknown): value is EntityPriority =>
  typeof value === "string" &&
  ENTITY_PRIORITIES.some((priority) => priority === value);

/**
 * Values accepted by a task's legal-list item discriminator. `TASK` is the
 * only actionable one: the rest are reference rows a matter reasons about.
 */
export const LIST_ITEM_TYPE = {
  TASK: "task",
  FACT: "fact",
  ISSUE: "issue",
  REQUIREMENT: "requirement",
  EVENT: "event",
} as const;

export const LIST_ITEM_TYPES = Object.freeze([
  LIST_ITEM_TYPE.TASK,
  LIST_ITEM_TYPE.FACT,
  LIST_ITEM_TYPE.ISSUE,
  LIST_ITEM_TYPE.REQUIREMENT,
  LIST_ITEM_TYPE.EVENT,
] as const);

export type ListItemType = (typeof LIST_ITEM_TYPES)[number];

export const isListItemType = (value: unknown): value is ListItemType =>
  typeof value === "string" &&
  LIST_ITEM_TYPES.some((itemType) => itemType === value);
