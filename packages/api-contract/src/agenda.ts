export const AGENDA_ITEM_KINDS = [
  "task",
  "deadline",
  "meeting",
  "hearing",
  "event",
] as const;

export type AgendaItemKind = (typeof AGENDA_ITEM_KINDS)[number];

export const AGENDA_ITEM_SOURCES = [
  "manual",
  "infosoud",
  "calendar",
  "email",
  "import",
  "api",
] as const;

export type AgendaItemSource = (typeof AGENDA_ITEM_SOURCES)[number];
