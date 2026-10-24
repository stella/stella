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
    names: ["recordAccountProfessionalUse"],
    allowed: [
      {
        path: "apps/api/src/handlers/me/accept-professional-use.ts",
        reason: "Accepts the current statement for the authenticated account.",
      },
      {
        path: "apps/api/src/scripts/review-account.ts",
        reason:
          "Records acceptance while provisioning the operator-owned review account.",
      },
      {
        path: "apps/api/src/lib/auth/professional-use.db.test.ts",
        reason: "Exercises account acceptance and its organization receipts.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
