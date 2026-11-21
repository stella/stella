import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "transaction-proof-minting",
  capability: "Minting transaction-bound checked proofs",
  owner: ["apps/api/src/lib/proofs/checked-transaction.ts"],
  summary:
    "The shared proof core names the actor, entity and transaction, runs the trusted predicate, and supplies evidence only after success. Predicate modules retain their domain checks.",
  enforcement: {
    kind: "import",
    specifiers: ["@gdp-ts/core"],
    names: ["defineProof"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
