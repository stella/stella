import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "synthetic-principal",
  capability: "Identifying the dedicated monitoring principal",
  owner: ["apps/api/src/lib/synthetic-principal/"],
  summary:
    "Consumers identify the monitoring principal through isSyntheticPrincipal. Stable identity literals belong to its provisioning owner and the database constraints.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/synthetic-principal/constants"],
    names: ["SYNTHETIC_PRINCIPAL"],
    allowed: [
      {
        path: "apps/api/src/db/auth-schema.ts",
        reason:
          "Derives the persisted session constraint from the principal owner.",
      },
      {
        path: "apps/api/src/db/synthetic-session-migration.db.test.ts",
        reason: "Exercises persisted identities on the database engine.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
