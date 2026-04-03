/** Valid status values per entity kind. */
export const TASK_STATUS = {
  OPEN: "open",
  IN_PROGRESS: "in_progress",
  IN_REVIEW: "in_review",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TASK_STATUSES = Object.values(TASK_STATUS);

const DOCUMENT_STATUS = {
  DRAFT: "draft",
  REVIEW: "review",
  FINAL: "final",
} as const;

export type DocumentStatus =
  (typeof DOCUMENT_STATUS)[keyof typeof DOCUMENT_STATUS];

export const DOCUMENT_STATUSES = Object.values(DOCUMENT_STATUS);

const ENTITY_PRIORITY = {
  NONE: "none",
  URGENT: "urgent",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export type EntityPriority =
  (typeof ENTITY_PRIORITY)[keyof typeof ENTITY_PRIORITY];

export const ENTITY_PRIORITIES = Object.values(ENTITY_PRIORITY);

export const TASK_ASSIGNEE_ROLE = {
  ASSIGNEE: "assignee",
  REVIEWER: "reviewer",
} as const;

export type TaskAssigneeRole =
  (typeof TASK_ASSIGNEE_ROLE)[keyof typeof TASK_ASSIGNEE_ROLE];

export const TASK_ASSIGNEE_ROLES = Object.values(TASK_ASSIGNEE_ROLE);

const ENTITY_LINK_TYPE = {
  RELATED: "related",
} as const;

export type EntityLinkType =
  (typeof ENTITY_LINK_TYPE)[keyof typeof ENTITY_LINK_TYPE];

export const ENTITY_LINK_TYPES = Object.values(ENTITY_LINK_TYPE);
