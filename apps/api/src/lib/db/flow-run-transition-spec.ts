import { FLOW_RUN_TERMINAL_STATUSES } from "@stll/api-contract";

import { flowRuns, flowRunSteps } from "@/api/db/schema";
import {
  defineNullableScopedTransitions,
  defineScopedTransitions,
  defineTransitions,
} from "@/api/lib/db/transitions";

// Migrations retain this graph; lifecycle changes require a new version and migration.
// INSERT has no predecessor: any domain status is valid initially. The run
// factory owns pending initialization; these graphs govern subsequent updates.
export const FLOW_RUN_TRANSITIONS_V1 = defineTransitions(
  flowRuns,
  {
    pending: ["running", "failed", "cancelled"],
    running: ["awaiting_review", "completed", "failed", "cancelled"],
    awaiting_review: ["running", "completed", "cancelled"],
    completed: [],
    failed: [],
    cancelled: [],
  },
  { terminal: FLOW_RUN_TERMINAL_STATUSES },
);

const FLOW_RUN_STATUS_TRANSITIONS = defineScopedTransitions({
  table: flowRuns,
  key: "id",
  scope: [],
  stateColumn: "status",
  edges: FLOW_RUN_TRANSITIONS_V1.edges,
  initial: [],
});

export const FLOW_RUN_RECOVERY_TRANSITIONS = defineNullableScopedTransitions({
  table: flowRuns,
  key: "id",
  scope: [],
  stateColumn: "recoveryState",
  edges: {
    "actor-removed": [],
    "completion-notice-pending": ["actor-removed"],
  },
  initial: [],
  nullTransitions: {
    fromNull: ["actor-removed", "completion-notice-pending"],
    toNull: ["completion-notice-pending"],
  },
});

export const FLOW_RUN_SCOPED_TRANSITIONS = {
  status: FLOW_RUN_STATUS_TRANSITIONS,
  recoveryState: FLOW_RUN_RECOVERY_TRANSITIONS,
} as const;

export const FLOW_RUN_STEP_TRANSITIONS_V1 = defineTransitions(
  flowRunSteps,
  {
    pending: ["running", "failed", "skipped"],
    running: ["awaiting_review", "completed", "failed", "skipped"],
    awaiting_review: ["completed", "skipped"],
    completed: [],
    failed: [],
    skipped: [],
  },
  { terminal: ["completed", "failed", "skipped"] },
);

export const FLOW_TRANSITION_SPECS_V1 = [
  FLOW_RUN_TRANSITIONS_V1,
  FLOW_RUN_STEP_TRANSITIONS_V1,
] as const;
