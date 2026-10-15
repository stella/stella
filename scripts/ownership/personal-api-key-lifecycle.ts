import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "personal-api-key-lifecycle",
  capability: "Managing member-owned credentials in the denied auth table",
  owner: ["apps/api/src/lib/machine-api-keys/personal-lifecycle.ts"],
  summary:
    "Bounded lifecycle operations retain organization and owner SQL predicates, lock live membership, enforce policy and active-key limits, and audit within the mutation transaction. No raw database handle is exported.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/machine-api-keys/personal-lifecycle"],
    allowed: [
      {
        path: "apps/api/src/handlers/api-keys/personal/create.ts",
        reason: "Owns the session-authorized personal key operation.",
      },
      {
        path: "apps/api/src/handlers/api-keys/personal/list.ts",
        reason: "Owns the session-authorized personal key operation.",
      },
      {
        path: "apps/api/src/handlers/api-keys/personal/revoke.ts",
        reason: "Owns the session-authorized personal key operation.",
      },
      {
        path: "apps/api/src/handlers/api-keys/personal/rotate.ts",
        reason: "Owns the session-authorized personal key operation.",
      },
      {
        path: "apps/api/src/handlers/api-keys/personal/list-organization.ts",
        reason: "Owns the session-authorized personal key operation.",
      },
      {
        path: "apps/api/src/handlers/api-keys/personal/revoke-organization.ts",
        reason: "Owns the session-authorized personal key operation.",
      },
      {
        path: "apps/api/src/handlers/api-keys/personal/policy.ts",
        reason: "Owns the session-authorized personal key operation.",
      },
      {
        path: "apps/api/src/lib/machine-api-keys/personal-policy-reader.ts",
        reason: "Exposes only the read-only organization policy operation.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
