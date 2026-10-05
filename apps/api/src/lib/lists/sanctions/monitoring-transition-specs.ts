import type { PgTable } from "drizzle-orm/pg-core";

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

import { SANCTIONS_MONITORING_TRANSITION_IDENTITIES } from "./monitoring-transition-identities";

type MonitoringTableName =
  (typeof SANCTIONS_MONITORING_TRANSITION_IDENTITIES)[keyof typeof SANCTIONS_MONITORING_TRANSITION_IDENTITIES]["tableName"];
const tables = {
  contacts,
  organizationSettings,
  sanctionsContactMatches,
  sanctionsContactScreenings,
} satisfies Record<MonitoringTableName, PgTable>;

export const CONTACT_MONITORING_TRANSITIONS = defineScopedTransitions({
  ...SANCTIONS_MONITORING_TRANSITION_IDENTITIES.CONTACT_MONITORING_TRANSITIONS,
  table:
    tables[
      SANCTIONS_MONITORING_TRANSITION_IDENTITIES.CONTACT_MONITORING_TRANSITIONS
        .tableName
    ],
  edges: { included: ["excluded"], excluded: ["included"] },
  initial: [],
});

export const FIRM_MONITORING_TRANSITIONS = defineScopedTransitions({
  ...SANCTIONS_MONITORING_TRANSITION_IDENTITIES.FIRM_MONITORING_TRANSITIONS,
  table:
    tables[
      SANCTIONS_MONITORING_TRANSITION_IDENTITIES.FIRM_MONITORING_TRANSITIONS
        .tableName
    ],
  edges: { enabled: ["disabled"], disabled: ["enabled"] },
  initial: ["enabled", "disabled"],
  sameStateUpsert: "ignore",
});

export const MATCH_MEMBERSHIP_TRANSITIONS = defineScopedTransitions({
  ...SANCTIONS_MONITORING_TRANSITION_IDENTITIES.MATCH_MEMBERSHIP_TRANSITIONS,
  table:
    tables[
      SANCTIONS_MONITORING_TRANSITION_IDENTITIES.MATCH_MEMBERSHIP_TRANSITIONS
        .tableName
    ],
  edges: { active: ["lapsed"], lapsed: ["active"] },
  initial: ["active"],
  sameStateUpsert: "update",
});

export const MATCH_REVIEW_TRANSITIONS = defineScopedTransitions({
  ...SANCTIONS_MONITORING_TRANSITION_IDENTITIES.MATCH_REVIEW_TRANSITIONS,
  table:
    tables[
      SANCTIONS_MONITORING_TRANSITION_IDENTITIES.MATCH_REVIEW_TRANSITIONS
        .tableName
    ],
  edges: {
    "needs-review": SANCTIONS_REVIEW_DISPOSITIONS,
    dismissed: SANCTIONS_REVIEW_DISPOSITIONS,
    confirmed: SANCTIONS_REVIEW_DISPOSITIONS,
  },
  initial: ["needs-review"],
  sameStateUpsert: "update",
});

export const SCREENING_COVERAGE_TRANSITIONS = defineScopedTransitions({
  ...SANCTIONS_MONITORING_TRANSITION_IDENTITIES.SCREENING_COVERAGE_TRANSITIONS,
  table:
    tables[
      SANCTIONS_MONITORING_TRANSITION_IDENTITIES.SCREENING_COVERAGE_TRANSITIONS
        .tableName
    ],
  edges: {
    clear: SANCTIONS_SCREENING_STATUSES,
    "possible-match": SANCTIONS_SCREENING_STATUSES,
    unavailable: SANCTIONS_SCREENING_STATUSES,
    excluded: SANCTIONS_SCREENING_STATUSES,
  },
  initial: SANCTIONS_SCREENING_STATUSES,
  sameStateUpsert: "update",
});
