import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "corpus-hit-classification",
  capability: "Classifying corpus engine hit identities",
  owner: ["apps/api/src/lib/legal-search/corpus-hit-disposition.ts"],
  summary:
    "The identity reader runs through one typed disposition owner in native, " +
    "scored, BM25 and highlight modes. Malformed hits are counted separately " +
    "from repeated passages and physical highlight copies.",
  enforcement: {
    kind: "function-call",
    name: "extractId",
    within: ["apps/api/src/lib/legal-search/", "apps/api/src/handlers/"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
