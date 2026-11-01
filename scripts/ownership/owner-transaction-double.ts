import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "owner-transaction-double",
  capability: "Owner transaction test doubles",
  owner: ["apps/api/src/lib/db/aggregate-lock.ts"],
  summary:
    "Owner-held row locks refuse any transaction that withOwnerAggregateTransaction did not open. Only test helpers may register a double as an owner transaction.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/db/aggregate-lock"],
    names: ["ownerTransactionDouble"],
    allowed: [
      {
        path: "apps/api/src/tests/helpers/",
        reason:
          "Test helpers hand owner transaction doubles to owner-held lock paths.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
