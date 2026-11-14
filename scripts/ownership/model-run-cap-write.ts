import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "model-run-cap-write",
  capability: "Charging and freeing an organization's model run caps",
  owner: ["apps/api/src/lib/usage/model-run-caps/"],
  summary:
    "The counters behind the model run caps move only through the run tables' triggers (migration-owned SQL), which charge a start and an active slot, refuse a run past either cap, and free the slot when the run ends. " +
    "Application code never writes a counter, so no path can admit a run the trigger did not count.",
  enforcement: {
    kind: "table-column-write",
    specifiers: ["@/api/db/schema", "@/api/db/schema/model-run-caps"],
    table: "modelRunBudgets",
    columns: [
      "runKind",
      "activeRuns",
      "startsDay",
      "startsToday",
      "activeLimit",
      "dailyLimit",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/lists/verification/recheck.db.test.ts",
        reason:
          "Seeds the list counter and fills its daily starts to reach the refusal a re-check meets.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
