import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "document-run-queue",
  capability:
    "Queueing and executing a member's run over one document (review, list verification)",
  owner: ["apps/api/src/lib/queue/document-run-queue.ts"],
  summary:
    "`createDocumentRunQueue` owns the one-shot skeleton every document run " +
    "shares: one attempt, the run id as the job id, the run's time budget, " +
    "the stuck rules, the worker's failure path and the queued and stuck " +
    "sweeps. A feature passes only its table's reads and transitions and its " +
    "execution. `scripts/queue-authority.ts` reads the factory call as the " +
    "feature module's worker.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-hand-built-document-run-queue/no-hand-built-document-run-queue",
    reason:
      "The BullMQ constructors stay open to other queues; the ban applies " +
      "where a module reads a document run table, which no import alone names.",
  },
} as const satisfies OwnershipEntry;
