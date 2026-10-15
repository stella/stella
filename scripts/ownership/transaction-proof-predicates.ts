import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "transaction-proof-predicates",
  capability: "Checking facts for transaction-bound proofs",
  owner: [
    "apps/api/src/lib/signals/proofs/signal-visible-to.ts",
    "apps/api/src/lib/signals/proofs/may-create-signal-request.ts",
  ],
  summary:
    "Only trusted predicate modules may invoke the shared proof boundary; operation callers use their domain checking functions.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/proofs/checked-transaction"],
    names: ["withCheckedTransaction"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
