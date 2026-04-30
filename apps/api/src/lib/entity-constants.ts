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

export const AGENDA_ITEM_KIND = {
  TASK: "task",
  DEADLINE: "deadline",
  MEETING: "meeting",
  HEARING: "hearing",
  EVENT: "event",
} as const;

export type AgendaItemKind =
  (typeof AGENDA_ITEM_KIND)[keyof typeof AGENDA_ITEM_KIND];

export const AGENDA_ITEM_KINDS = Object.values(AGENDA_ITEM_KIND);

export const AGENDA_ITEM_SOURCE = {
  MANUAL: "manual",
  INFOSOUD: "infosoud",
  CALENDAR: "calendar",
  EMAIL: "email",
  IMPORT: "import",
  API: "api",
} as const;

export type AgendaItemSource =
  (typeof AGENDA_ITEM_SOURCE)[keyof typeof AGENDA_ITEM_SOURCE];

export const AGENDA_ITEM_SOURCES = Object.values(AGENDA_ITEM_SOURCE);

export const AGENDA_AVAILABILITY = {
  FREE: "free",
  TENTATIVE: "tentative",
  BUSY: "busy",
  OUT_OF_OFFICE: "out_of_office",
  WORKING_ELSEWHERE: "working_elsewhere",
  UNKNOWN: "unknown",
} as const;

export type AgendaAvailability =
  (typeof AGENDA_AVAILABILITY)[keyof typeof AGENDA_AVAILABILITY];

export const AGENDA_AVAILABILITIES = Object.values(AGENDA_AVAILABILITY);

export const AGENDA_SENSITIVITY = {
  NORMAL: "normal",
  PRIVATE: "private",
  CONFIDENTIAL: "confidential",
} as const;

export type AgendaSensitivity =
  (typeof AGENDA_SENSITIVITY)[keyof typeof AGENDA_SENSITIVITY];

export const AGENDA_SENSITIVITIES = Object.values(AGENDA_SENSITIVITY);

export const AGENDA_ATTENDEE_TYPE = {
  REQUIRED: "required",
  OPTIONAL: "optional",
  RESOURCE: "resource",
} as const;

export type AgendaAttendeeType =
  (typeof AGENDA_ATTENDEE_TYPE)[keyof typeof AGENDA_ATTENDEE_TYPE];

export const AGENDA_ATTENDEE_TYPES = Object.values(AGENDA_ATTENDEE_TYPE);

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
