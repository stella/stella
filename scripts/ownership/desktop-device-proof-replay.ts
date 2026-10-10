import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "desktop-device-proof-replay",
  capability: "Claiming desktop device proofs once",
  owner: ["apps/api/src/lib/business-registries/desktop/proof-store.ts"],
  summary:
    "The denied replay table records each verified proof once independently of business transactions. Indexed pruning removes only its expired rows in bounded batches.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/business-registries/desktop/proof-store"],
    allowed: [
      {
        path: "apps/api/src/lib/business-registries/desktop/auth.ts",
        reason:
          "Consumes a request proof before accepting an account credential.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/link-grants.ts",
        reason: "Consumes the device proof before claiming an issuance grant.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/renewal.ts",
        reason:
          "Requires the consumed authority when rotating the locked credential.",
      },
      {
        path: "apps/api/src/handlers/desktop-registry/redeem-link.postgres.test.ts",
        reason:
          "Exercises production redemption authorization and replay exclusion with real transactions.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/proof.postgres.test.ts",
        reason:
          "Exercises replay exclusion and bounded expiry pruning with real transactions.",
      },
      {
        path: "apps/api/src/lib/business-registries/desktop/renewal.postgres.test.ts",
        reason:
          "Exercises proof-bound credential rotation with real transactions.",
      },
      {
        path: "apps/api/src/tests/helpers/desktop-device-proof.ts",
        reason:
          "Builds verified proof authorities for handler fixtures with an injected receipt store.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
