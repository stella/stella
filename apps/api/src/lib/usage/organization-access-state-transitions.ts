import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

export const ORGANIZATION_ACCESS_STATE_TRANSITIONS = defineScopedTransitions({
  table: organizationAccessStates,
  key: "organizationId",
  scope: [],
  stateColumn: "state",
  edges: {
    [ORGANIZATION_ACCESS_STATE.selfManagedKeys]: [
      ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      ORGANIZATION_ACCESS_STATE.evaluationEnded,
    ],
    [ORGANIZATION_ACCESS_STATE.evaluationPeriod]: [
      ORGANIZATION_ACCESS_STATE.evaluationEnded,
    ],
    [ORGANIZATION_ACCESS_STATE.evaluationEnded]: [],
  },
  initial: [
    ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    ORGANIZATION_ACCESS_STATE.evaluationPeriod,
  ],
});
