export const ENTITY_NAME_MAX_LENGTH = 255;

/** Bound an entity name without splitting a UTF-16 surrogate pair. */
export const truncateEntityName = (
  value: string,
  maxLength = ENTITY_NAME_MAX_LENGTH,
): string => {
  const characters: string[] = [];
  let length = 0;
  for (const character of value.toWellFormed()) {
    if (length + character.length > maxLength) {
      break;
    }
    characters.push(character);
    length += character.length;
  }
  return characters.join("");
};

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

/** The statuses a task is finished in: nothing is left to do either way. */
export const TASK_CLOSED_STATUSES = [
  TASK_STATUS.DONE,
  TASK_STATUS.CANCELLED,
] as const satisfies readonly TaskStatus[];

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
