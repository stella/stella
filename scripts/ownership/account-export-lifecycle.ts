import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "account-export-lifecycle",
  capability: "Requesting, claiming and reconciling account-owned exports",
  owner: ["apps/api/src/lib/account-export/store.ts"],
  summary:
    "Account export work belongs to the authenticated account independently " +
    "of organization membership. The store binds application-role reads and " +
    "requests to that user; background workers use the owning connection for " +
    "bounded durable recovery, lease transitions and artifact reclamation. " +
    "Account row locks serialize creation and publication with account erasure.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/db/schema/account-exports", "@/api/db/schema"],
    names: ["accountExports"],
    allowed: [
      {
        path: "apps/api/src/lib/account-export/store.postgres.test.ts",
        reason:
          "Exercises migrated lifecycle transitions and generic account isolation.",
      },
      {
        path: "apps/api/src/lib/account-deletion-steps.ts",
        reason:
          "Removes the ledger and preserves artifact keys for durable erasure cleanup.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
