import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "desktop-account-bootstrap",
  capability: "Claiming desktop connection and document handoff requests",
  owner: [
    "apps/api/src/lib/auth.ts",
    "apps/api/src/lib/business-registries/desktop/link-grants.ts",
    "apps/api/src/lib/business-registries/desktop/link-grant-store.ts",
    "apps/api/src/lib/desktop-edit-handoffs.ts",
  ],
  summary:
    "Connection verification rows deny application-role access. These owners " +
    "claim short-lived requests atomically, bind their stored account to the " +
    "request, and bootstrap live member scope before document access.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/business-registries/desktop/link-grants",
      "@/api/lib/business-registries/desktop/link-grant-store",
      "@/api/lib/desktop-edit-handoffs",
    ],
    allowed: [
      {
        path: "apps/api/src/handlers/desktop-registry/grant.ts",
        reason: "Creates the authenticated browser connection request.",
      },
      {
        path: "apps/api/src/handlers/desktop-registry/redeem-link.ts",
        reason: "Claims the native connection request.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/handoff-auth.ts",
        reason:
          "Records a terminal handoff acknowledgement before returning a protocol or account refusal.",
      },
      {
        path: "apps/api/src/handlers/entities/desktop-edit-handoffs.ts",
        reason: "Creates and claims document handoffs.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/link-grants.test.ts",
        reason: "Exercises connection claims.",
      },
      {
        path: "apps/api/src/lib/desktop-edit-handoffs.integration.test.ts",
        reason: "Exercises document handoff claims.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
