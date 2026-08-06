export {
  ENTITY_PRIORITIES,
  ENTITY_PRIORITY,
  TASK_STATUS,
  TASK_STATUSES,
} from "@stll/api-contract";
export type { EntityPriority, TaskStatus } from "@stll/api-contract";

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

export const AGENDA_ATTENDEE_TYPES = Object.values(AGENDA_ATTENDEE_TYPE);

const DOCUMENT_STATUS = {
  DRAFT: "draft",
  REVIEW: "review",
  FINAL: "final",
} as const;

export type DocumentStatus =
  (typeof DOCUMENT_STATUS)[keyof typeof DOCUMENT_STATUS];

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

export const ENTITY_LINK_TYPES = Object.values(ENTITY_LINK_TYPE);
