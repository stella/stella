export const AUDIT_CHANGES_STATUS = {
  visible: "visible",
  featureUnavailable: "feature_unavailable",
} as const;

/**
 * Who performed the audited change. People covers members and the agents
 * acting for them; automations are the background services that write under a
 * `system:` actor.
 */
export const AUDIT_PERFORMER_FILTER = {
  people: "people",
  automations: "automations",
} as const;

export type AuditPerformerFilter =
  (typeof AUDIT_PERFORMER_FILTER)[keyof typeof AUDIT_PERFORMER_FILTER];
