export const ENTITY_VIEW_GROUP = {
  STATUS: "_status",
  KIND: "_kind",
  TYPE: "_agenda-kind",
  MATTER: "_matter",
  ASSIGNEE: "_assignee",
  AUTHOR: "_created-by",
} as const;

export const ENTITY_VIEW_COLUMNS = {
  _name: { sortable: true },
  _matter: { sortable: false },
  "_agenda-kind": { sortable: false },
  _status: { sortable: true },
  _priority: { sortable: true },
  "_due-date": { sortable: true },
  _assignee: { sortable: false },
  _actions: { sortable: false },
} as const;

/**
 * What a row of the shared cross-matter window is: a stored entity, or an
 * Inbox signal served in the same result set and ordered by the same sorts.
 */
export const ENTITY_VIEW_ROW_KIND = {
  ENTITY: "entity",
  SIGNAL: "signal",
} as const;
export type EntityViewRowKind =
  (typeof ENTITY_VIEW_ROW_KIND)[keyof typeof ENTITY_VIEW_ROW_KIND];

/**
 * Governed-work state a task row carries: `at_risk` when its work obligation
 * is still open and its hard deadline or working target is already due (the
 * same predicate as the My Work at-risk queue).
 */
export const ENTITY_VIEW_WORK_RISK = {
  AT_RISK: "at_risk",
  NONE: "none",
} as const;
export type EntityViewWorkRisk =
  (typeof ENTITY_VIEW_WORK_RISK)[keyof typeof ENTITY_VIEW_WORK_RISK];
