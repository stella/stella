/**
 * Notifications: per-user, transient awareness pointers ("you were mentioned",
 * "your export finished", "your flow run needs approval", "announcement").
 *
 * A notification carries no actionable work state and never represents a
 * deadline or governed work — that is the signals/obligations system. Its only
 * state is read/unread.
 *
 * The database stores the KIND, never an i18n key. The web maps kind to a
 * translation key. `NOTIFICATION_METADATA` binds each kind to the exact set of
 * ICU parameters its message renders, so a producer cannot send parameters the
 * message does not use and a new kind cannot land without deciding both.
 */

export const NOTIFICATION_KIND = {
  MENTION: "mention",
  REPORT_EXPORT_SUCCEEDED: "report_export_succeeded",
  REPORT_EXPORT_FAILED: "report_export_failed",
  FLOW_RUN_COMPLETED: "flow_run_completed",
  FLOW_RUN_FAILED: "flow_run_failed",
  FLOW_RUN_AWAITING_APPROVAL: "flow_run_awaiting_approval",
  ANNOUNCEMENT: "announcement",
} as const;
export type NotificationKind =
  (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];
export const NOTIFICATION_KINDS = [
  NOTIFICATION_KIND.MENTION,
  NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED,
  NOTIFICATION_KIND.REPORT_EXPORT_FAILED,
  NOTIFICATION_KIND.FLOW_RUN_COMPLETED,
  NOTIFICATION_KIND.FLOW_RUN_FAILED,
  NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL,
  NOTIFICATION_KIND.ANNOUNCEMENT,
] as const satisfies readonly NotificationKind[];

/**
 * The entity a notification points at. Closed so a pointer can only name a
 * shape the client knows how to resolve; `null` is the announcement case,
 * which points at nothing.
 */
export const NOTIFICATION_ENTITY_TYPE = {
  ENTITY: "entity",
  FLOW_RUN: "flow_run",
  REPORT_EXPORT: "report_export",
} as const;
export type NotificationEntityType =
  (typeof NOTIFICATION_ENTITY_TYPE)[keyof typeof NOTIFICATION_ENTITY_TYPE];
export const NOTIFICATION_ENTITY_TYPES = [
  NOTIFICATION_ENTITY_TYPE.ENTITY,
  NOTIFICATION_ENTITY_TYPE.FLOW_RUN,
  NOTIFICATION_ENTITY_TYPE.REPORT_EXPORT,
] as const satisfies readonly NotificationEntityType[];

/**
 * Values a message parameter may take. Deliberately narrow: metadata is
 * message input, not a payload, so it can never carry nested state.
 */
export type NotificationMetadataValue = Record<string, string | number>;

/**
 * Compile-time totality gate for the metadata map below. A kind added to
 * `NOTIFICATION_KIND` without a metadata shape fails this constraint, so the
 * two can never drift.
 */
type TotalMetadataMap<
  T extends Record<NotificationKind, NotificationMetadataValue>,
> = T;

/**
 * Per kind, the exact ICU parameters its message renders. Adding a field here
 * without adding the placeholder (or the reverse) is caught by the web's
 * `i18n:check` on the message and by the producer's own call site here.
 */
export type NotificationMetadataByKind = TotalMetadataMap<{
  [NOTIFICATION_KIND.MENTION]: { actorName: string };
  [NOTIFICATION_KIND.REPORT_EXPORT_SUCCEEDED]: Record<string, never>;
  [NOTIFICATION_KIND.REPORT_EXPORT_FAILED]: Record<string, never>;
  [NOTIFICATION_KIND.FLOW_RUN_COMPLETED]: { flowName: string };
  [NOTIFICATION_KIND.FLOW_RUN_FAILED]: { flowName: string };
  [NOTIFICATION_KIND.FLOW_RUN_AWAITING_APPROVAL]: { flowName: string };
  [NOTIFICATION_KIND.ANNOUNCEMENT]: { title: string };
}>;

/** The kind plus the metadata that kind's message needs, as one union. */
export type NotificationContent = {
  [K in NotificationKind]: {
    kind: K;
    metadata: NotificationMetadataByKind[K];
  };
}[NotificationKind];

/** Longest announcement title the operator endpoint accepts. */
export const ANNOUNCEMENT_TITLE_MAX_LENGTH = 200;
