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

/** The agenda columns every entity read carries on the wire, whatever its kind. */
export type AgendaItemWireFields = {
  dueDate: string | null;
  agendaKind: AgendaItemKind;
  startAt: string | null;
  endAt: string | null;
  occurredAt: string | null;
  remindAt: string | null;
  allDay: boolean;
  timeZone: string | null;
  location: string | null;
  onlineMeetingUrl: string | null;
  availability: string | null;
  sensitivity: string | null;
  organizer: unknown;
  attendees: unknown;
  recurrence: unknown;
  agendaSource: AgendaItemSource;
  externalSource: string | null;
  externalId: string | null;
  externalChangeKey: string | null;
  externalICalUid: string | null;
};
