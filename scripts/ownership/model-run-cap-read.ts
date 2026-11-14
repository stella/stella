import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "model-run-cap-read",
  capability: "Checking an organization's model run caps",
  owner: ["apps/api/src/lib/usage/model-run-caps/"],
  summary:
    "An organization's caps on model runs (active runs and daily starts per kind: list runs, document reviews) are read and decided in one module. " +
    "A start goes through `startModelRun`, a worker's model call through `checkModelRunCaps`, and a refusal answers with the shared codes through `modelRunCapRefusal`, " +
    "so no feature reads the counter itself and decides with its own arithmetic.",
  enforcement: {
    kind: "table-column-read",
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
        path: "apps/api/src/handlers/lists/fact-extractions/create.db.test.ts",
        reason:
          "Asserts a refused or finished extraction leaves the shared list counter as the trigger keeps it.",
      },
      {
        path: "apps/api/src/lib/lists/generation/run-queue.db.test.ts",
        reason:
          "Asserts a finished extraction freed its active slot and kept its start.",
      },
      {
        path: "apps/api/src/lib/lists/verification/recheck.db.test.ts",
        reason:
          "Fills the list counter to its recorded daily limit to reach the refusal a re-check meets.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
