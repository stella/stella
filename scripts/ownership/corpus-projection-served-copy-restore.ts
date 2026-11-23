import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "corpus-projection-served-copy-restore",
  capability:
    "Returning a queued corpus projection copy a state still names to applied",
  owner: [
    "apps/api/src/lib/legal-search/corpus-index-projection-served-copy-restore.ts",
  ],
  summary:
    "One transition returns a served cleanup_pending revision to applied, and only two writers decide it: the cleanup claim's restore branch and the repair writer, which restores a queued copy that is still provably the one readers are served before its repair moves any epoch. Both decide under the state's and the revision's row locks; the database guard repeats the restore predicate.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/lib/legal-search/corpus-index-projection-served-copy-restore",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/legal-search/corpus-index-projection-cleanup-store.ts",
        reason:
          "The cleanup claim restores a served revision no delete reached instead of claiming it.",
      },
      {
        path: "apps/api/src/lib/legal-search/corpus-index-projection-desired-state.ts",
        reason:
          "The repair writer restores a still restorable queued copy before its repair would cost the copy its proof.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
