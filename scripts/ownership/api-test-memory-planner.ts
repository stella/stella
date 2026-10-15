import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "api-test-memory-planner",
  capability: "Measured API test memory and batch composition",
  owner: ["apps/api/scripts/test-batch-plan.ts"],
  summary:
    "The planner owns measured peak RSS, conservative unknown weights and automatic process isolation. Batch plans must fit their execution-class memory caps before a test starts.",
  enforcement: {
    kind: "import",
    specifiers: ["apps/api/scripts/test-peak-rss.json"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
