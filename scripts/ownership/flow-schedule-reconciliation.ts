import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "flow-schedule-reconciliation",
  capability: "Reconciling a flow definition's derived scheduler job",
  owner: ["apps/api/src/lib/scheduler/jobs.ts"],
  summary:
    "The named reconcileCommittedFlowSchedule operation accepts only a definition and organization identity. It " +
    "holds the persistent definition fence, scheduler row and scoped definition " +
    "lock while reading current state and changing the derived job on the same " +
    "transaction. Scoped absence checks global identity existence before removal, " +
    "so a retired organization cannot remove another current owner's job. " +
    "It delegates to a helper with required database and canonical upsert dependencies, returns Promise<void> and exposes no database handle. " +
    "The caller captures failures as before; post-commit reconciliation remains " +
    "best effort and does not close the crash gap between definition commit " +
    "and reconciliation.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/scheduler/jobs"],
    names: ["reconcileCommittedFlowSchedule"],
    allowed: [
      {
        path: "apps/api/src/lib/flows/sync-flow-schedule-trigger.ts",
        reason:
          "Reconciles the identity committed by the flow create, update or delete handler.",
      },
      {
        path: "apps/api/src/lib/scheduler/reconcile-flow-schedule.postgres.test.ts",
        reason:
          "Exercises actual current-state reconciliation and organization isolation against PostgreSQL.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
