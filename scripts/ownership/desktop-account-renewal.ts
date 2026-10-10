import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "desktop-account-renewal",
  capability: "Renewing account-bound desktop credentials",
  owner: ["apps/api/src/lib/business-registries/desktop/renewal.ts"],
  summary:
    "Renewal locks live membership and the purpose-bound credential, rotates its digest and inactivity deadline, and commits its audit in the same transaction. Recovery probes preserve the deadline.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/business-registries/desktop/renewal"],
    allowed: [
      {
        path: "apps/api/src/lib/business-registries/desktop/auth.ts",
        reason:
          "Checks the locked inactivity deadline before accepting a credential.",
      },
      {
        path: "apps/api/src/handlers/desktop-registry/renew.ts",
        reason: "Authorizes the native renewal or recovery request.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/renewal.postgres.test.ts",
        reason: "Exercises the lifecycle with real database transactions.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
