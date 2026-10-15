import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "flow-run-completion-notice",
  capability: "Notifying a flow run's actor when a reviewer completes the run",
  owner: ["apps/api/src/lib/flows/flow-run-completion-notice.ts"],
  summary:
    "Approving a run's last review gate completes a run whose actor is usually " +
    "another user. Resolving that actor and filing their notification are both " +
    "cross-user, so one operation does both on the owner connection, with the " +
    "recipient derived from the run and a run-keyed idempotency key.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/flows/flow-run-completion-notice"],
    allowed: [
      {
        path: "apps/api/src/lib/flows/flow-executor.ts",
        reason:
          "The review-gate resolver files the notice when an approval finishes the run.",
      },
      {
        path: "apps/api/src/handlers/fields/kanban-placement/update.ts",
        reason:
          "Kanban collects the resolver's run-derived notice and files it after its outer transaction commits.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
