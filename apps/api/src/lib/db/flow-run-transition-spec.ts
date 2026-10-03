import { FLOW_RUN_TERMINAL_STATUSES } from "@stll/api-contract";

import { flowRuns } from "@/api/db/schema";
import { defineTransitions } from "@/api/lib/db/transitions";

// Migrations retain this graph; lifecycle changes require a new version and migration.
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
