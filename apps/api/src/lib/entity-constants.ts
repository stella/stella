import type { AgendaItemKind, AgendaItemSource } from "@stll/api-contract";

import type { ConstantMap } from "@/api/lib/constant-map";

export {
  AGENDA_ITEM_KINDS,
  AGENDA_ITEM_SOURCES,
  ENTITY_PRIORITIES,
  ENTITY_PRIORITY,
  TASK_STATUS,
  TASK_STATUSES,
} from "@stll/api-contract";
export type {
  AgendaItemKind,
  AgendaItemSource,
  EntityPriority,
  TaskStatus,
} from "@stll/api-contract";

/**
 * The agenda enums, declared once.
 *
 * Everything that needs the full set derives from these tuples: the union
 * types, the Drizzle column enums on `entities`, and the request validators.
 * They are tuples rather than `Object.values(...)` results because Drizzle's
 * `text({ enum })` only narrows a column to a literal union for a readonly
 * tuple.
 */
export const AGENDA_AVAILABILITIES = [
  "free",
  "tentative",
  "busy",
  "out_of_office",
  "working_elsewhere",
  "unknown",
] as const;

export type AgendaAvailability = (typeof AGENDA_AVAILABILITIES)[number];

export const AGENDA_SENSITIVITIES = [
  "normal",
  "private",
  "confidential",
] as const;

export type AgendaSensitivity = (typeof AGENDA_SENSITIVITIES)[number];

export const AGENDA_ATTENDEE_TYPES = [
  "required",
  "optional",
  "resource",
] as const;

export type AgendaAttendeeType = (typeof AGENDA_ATTENDEE_TYPES)[number];

export const AGENDA_ITEM_KIND = {
  TASK: "task",
  DEADLINE: "deadline",
  MEETING: "meeting",
  HEARING: "hearing",
  EVENT: "event",
} as const satisfies ConstantMap<AgendaItemKind>;

export const AGENDA_ITEM_SOURCE = {
  MANUAL: "manual",
  INFOSOUD: "infosoud",
  CALENDAR: "calendar",
  EMAIL: "email",
  IMPORT: "import",
  API: "api",
} as const satisfies ConstantMap<AgendaItemSource>;

export const AGENDA_AVAILABILITY = {
  FREE: "free",
  TENTATIVE: "tentative",
  BUSY: "busy",
  OUT_OF_OFFICE: "out_of_office",
  WORKING_ELSEWHERE: "working_elsewhere",
  UNKNOWN: "unknown",
} as const satisfies ConstantMap<AgendaAvailability>;

export const AGENDA_SENSITIVITY = {
  NORMAL: "normal",
  PRIVATE: "private",
  CONFIDENTIAL: "confidential",
} as const satisfies ConstantMap<AgendaSensitivity>;

export const AGENDA_ATTENDEE_TYPE = {
  REQUIRED: "required",
  OPTIONAL: "optional",
  RESOURCE: "resource",
} as const satisfies ConstantMap<AgendaAttendeeType>;

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
