import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "desktop-account-issuance",
  capability: "Issuing account-bound desktop credentials",
  owner: ["apps/api/src/lib/business-registries/desktop/issuance.ts"],
  summary:
    "Issuance holds the account's credential fence with the connection request's live browser session, rechecks the desktop permission under the membership lock, and writes the credential with its audit in the same transaction.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/business-registries/desktop/issuance"],
    allowed: [
      {
        path: "apps/api/src/handlers/desktop-registry/redeem-link.ts",
        reason:
          "Issues the credential a claimed connection request authorizes.",
      },
      {
        path: "apps/api/src/lib/machine-api-keys/personal-lifecycle.postgres.test.ts",
        reason:
          "Races every session-authorized issuer against an access reset.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
