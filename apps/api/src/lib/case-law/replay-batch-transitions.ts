import { caseLawReplayBatches } from "@/api/db/schema";
import { defineLifecycle } from "@/api/lib/db/transitions";

// Readmission and recovery move the attempt and receipt status atomically.
// Legacy replay writers remain in the shrinking direct-write ledger.
export const CASE_LAW_REPLAY_BATCH_TRANSITIONS = defineLifecycle({
  table: caseLawReplayBatches,
  key: "id",
  graphs: {
    status: {
      edges: {
        reserved: [
          "completed",
          "blocked",
          "superseded",
          "retry-exhausted",
          "retry-terminal",
        ],
        "retry-exhausted": ["reserved", "superseded"],
        "retry-terminal": [],
        completed: ["reserved", "retry-terminal"],
        superseded: ["reserved", "retry-terminal"],
        failed: [],
        blocked: [],
      },
      terminal: ["retry-terminal", "failed", "blocked"],
    },
    attemptState: {
      edges: { idle: ["picked-up"], "picked-up": ["idle"] },
      terminal: [],
    },
  },
});
