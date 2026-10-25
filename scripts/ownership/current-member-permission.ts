import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "current-member-permission",
  capability:
    "Revalidating a persisted membership during an authorized operation",
  owner: ["apps/api/src/lib/permission-authorization.ts"],
  summary:
    "The request spends its credential at the handler boundary; a locked membership is revalidated by the permission owner.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/permission-authorization"],
    names: ["hasCurrentMemberPermission"],
    allowed: [
      {
        path: "apps/api/src/lib/business-registries/desktop/renewal.ts",
        reason:
          "Revalidates the locked membership after desktop credential authorization.",
      },
      {
        path: "apps/api/src/lib/workspace-deletion.ts",
        reason:
          "Revalidates the actor's locked membership after the handler authorizes deletion.",
      },
      {
        path: "apps/api/src/lib/db/member-authority.ts",
        reason:
          "Provides shared transaction-held organization and matter membership rechecks for deferred actions.",
      },
      {
        path: "apps/api/src/lib/memory/persist-explicit-memory.ts",
        reason:
          "Revalidates the locked member role immediately before persisting an explicit memory.",
      },
      {
        path: "apps/api/src/lib/flows/start-automated-flow-run.ts",
        reason:
          "Revalidates the definition author's current role before scheduling a durable run.",
      },
      {
        path: "apps/api/src/handlers/reports/report-export-queue.ts",
        reason:
          "Revalidates the queued export requester's current role before loading report content.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
