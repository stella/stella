import {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
} from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";
import {
  SANCTIONS_SCREENING_STATUSES,
  SANCTIONS_REVIEW_DISPOSITIONS,
} from "@/api/lib/lists/sanctions/monitoring-vocabulary";

export const CONTACT_MONITORING_TRANSITIONS = defineScopedTransitions({
  table: contacts,
  key: "id",
  scope: [],
  stateColumn: "sanctionsMonitoringMode",
  edges: { included: ["excluded"], excluded: ["included"] },
  initial: [],
});

export const FIRM_MONITORING_TRANSITIONS = defineScopedTransitions({
  table: organizationSettings,
  key: "organizationId",
  scope: [],
  stateColumn: "sanctionsMonitoringMode",
  edges: { enabled: ["disabled"], disabled: ["enabled"] },
  initial: ["enabled", "disabled"],
  sameStateUpsert: "ignore",
});

export const MATCH_MEMBERSHIP_TRANSITIONS = defineScopedTransitions({
  table: sanctionsContactMatches,
  key: "sourceEntryId",
  scope: ["organizationId", "contactId", "sourceId"],
  stateColumn: "state",
  edges: { active: ["lapsed"], lapsed: ["active"] },
  initial: ["active"],
  sameStateUpsert: "update",
});

export const MATCH_REVIEW_TRANSITIONS = defineScopedTransitions({
  table: sanctionsContactMatches,
  key: "sourceEntryId",
  scope: ["organizationId", "contactId", "sourceId"],
  stateColumn: "disposition",
  edges: {
    "needs-review": SANCTIONS_REVIEW_DISPOSITIONS,
    dismissed: SANCTIONS_REVIEW_DISPOSITIONS,
    confirmed: SANCTIONS_REVIEW_DISPOSITIONS,
  },
  initial: ["needs-review"],
  sameStateUpsert: "update",
});

export const SCREENING_COVERAGE_TRANSITIONS = defineScopedTransitions({
  table: sanctionsContactScreenings,
  key: "contactId",
  scope: ["organizationId", "sourceId"],
  stateColumn: "status",
  edges: {
    clear: SANCTIONS_SCREENING_STATUSES,
    "possible-match": SANCTIONS_SCREENING_STATUSES,
    unavailable: SANCTIONS_SCREENING_STATUSES,
    excluded: SANCTIONS_SCREENING_STATUSES,
  },
  initial: SANCTIONS_SCREENING_STATUSES,
  sameStateUpsert: "update",
});
