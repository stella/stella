// Shared identity declarations let tooling enforce the same state columns
// without importing the runtime schema or transition owner.
export const SANCTIONS_MONITORING_TRANSITION_IDENTITIES = {
  CONTACT_MONITORING_TRANSITIONS: {
    tableName: "contacts",
    key: "id",
    scope: [],
    stateColumn: "sanctionsMonitoringMode",
  },
  FIRM_MONITORING_TRANSITIONS: {
    tableName: "organizationSettings",
    key: "organizationId",
    scope: [],
    stateColumn: "sanctionsMonitoringMode",
  },
  MATCH_MEMBERSHIP_TRANSITIONS: {
    tableName: "sanctionsContactMatches",
    key: "sourceEntryId",
    scope: ["organizationId", "contactId", "sourceId"],
    stateColumn: "state",
  },
  MATCH_REVIEW_TRANSITIONS: {
    tableName: "sanctionsContactMatches",
    key: "sourceEntryId",
    scope: ["organizationId", "contactId", "sourceId"],
    stateColumn: "disposition",
  },
  SCREENING_COVERAGE_TRANSITIONS: {
    tableName: "sanctionsContactScreenings",
    key: "contactId",
    scope: ["organizationId", "sourceId"],
    stateColumn: "status",
  },
} as const;
