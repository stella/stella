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
        path: "apps/api/src/handlers/data-exports/data-export-worker.ts",
        reason:
          "Revalidates the requester's membership before each queued export attempt reads the organization.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
