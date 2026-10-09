import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "deterministic-job-requeue",
  capability:
    "Re-enqueueing a row's work under its deterministic BullMQ job id",
  owner: ["apps/api/src/lib/bullmq-requeue.ts"],
  summary:
    "A queue ignores an `add` whose id it still holds, and retention keeps " +
    "terminal records after the row they ran for is reopened, so every " +
    "enqueue under a reused id reads the job's state first. " +
    "`requeueDeterministicJob` maps each state BullMQ reports to one action " +
    "from a total table (live states are owned, a failed job is retried " +
    "with a fresh attempt budget, a completed one is replaced) and bounds " +
    "every queue command, so the enqueue paths and the reconcilers that " +
    "repeat them cannot drift apart.",
  enforcement: {
    kind: "member-call",
    method: "getState",
    within: ["apps/api/src/"],
    allowed: [
      {
        path: "apps/api/src/lib/report-export-recovery.ts",
        reason:
          "Reads a job's state to decide whether an export outlived its job; it never enqueues.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
