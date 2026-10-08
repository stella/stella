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
        path: "apps/api/src/lib/workspace-deletion.ts",
        reason:
          "Revalidates the actor's locked membership after the handler authorizes deletion.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
