import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "professional-use-acceptance",
  capability: "Recording the signed-in account's professional-use acceptance",
  owner: ["apps/api/src/lib/auth/professional-use.ts"],
  summary:
    "Records insert-once account and organization acceptances with account-level serialization and transactional audit rows.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/auth/professional-use"],
    names: ["acceptAccountProfessionalUse"],
    allowed: [
      {
        path: "apps/api/src/handlers/me/accept-professional-use.ts",
        reason: "Accepts the current statement for the authenticated account.",
      },
      {
        path: "apps/api/src/lib/auth/professional-use.db.test.ts",
        reason: "Exercises account acceptance and its organization receipts.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
