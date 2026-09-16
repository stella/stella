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
