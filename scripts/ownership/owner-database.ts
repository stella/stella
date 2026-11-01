import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "owner-database",
  capability: "Owner connection registration",
  owner: ["apps/api/src/lib/db/owner-transaction.ts"],
  summary:
    "A connection that runs as the table owner is registered where it is constructed; owner-held row locks accept only transactions opened on a registered connection. Only the root and maintenance connection modules and test helpers register one.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/db/owner-transaction"],
    names: ["createOwnerDatabase"],
    allowed: [
      {
        path: "apps/api/src/db/root.ts",
        reason:
          "Registers the root connection and the scoped pool's owner phase.",
      },
      {
        path: "apps/api/src/lib/db/maintenance-db.ts",
        reason: "Registers the operator script connection on the root pool.",
      },
      {
        path: "apps/api/src/tests/helpers/",
        reason:
          "Test helpers register database doubles that stand in for the owner connection.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
