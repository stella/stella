import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "corpus-projection-served-copy-retirement",
  capability: "Retiring a corpus projection copy a state still names",
  owner: [
    "apps/api/src/lib/legal-search/corpus-index-projection-desired-state.ts",
  ],
  summary:
    "The desired-state writer owns served-copy protection. A named copy leaves readers only through a canonical change it writes (an undone erasure) or through the one-off pass over copies an earlier release kept through a recorded erasure; a repair is held before it could retire, expose or unprove a named copy. The general retirement is private to the owner, and its legacy entry point is confined to that pass.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/legal-search/corpus-index-projection-desired-state",
    ],
    names: ["retireLegacyErasedServedCopiesTx"],
    allowed: [
      {
        path: "apps/api/src/lib/legal-search/corpus-index-projection-legacy-retire.ts",
        reason:
          "The one-off pass retires only copies with a recorded erasure in its window, the genuine-erasure path for rows an earlier release left served.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
