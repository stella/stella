import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "account-export-lifecycle",
  capability: "Requesting, claiming and reconciling account-owned exports",
  owner: ["apps/api/src/lib/account-export/store.ts"],
  summary:
    "Account export work belongs to the authenticated account independently " +
    "of organization membership. The store binds request-time reads and " +
    "requests to that user; background workers perform bounded durable " +
    "recovery, lease transitions and artifact reclamation. " +
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
        path: "apps/api/src/lib/db/transition-specs.ts",
        reason:
          "Declares the ledger's lifecycle graph for the transition owner.",
      },
      {
        path: "apps/api/src/lib/account-deletion-steps.ts",
        reason:
          "Removes the ledger and preserves artifact keys for durable erasure cleanup.",
      },
      {
        path: "apps/api/src/db/entity-feature-gate-repair.ts",
        reason:
          "Reads each table's declared RLS policy metadata to cut over the entity-feature gate; never reads or writes ledger rows.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
