import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "query-view",
  capability: "Presenting non-suspense query results",
  owner: [
    "apps/web/src/lib/query-view.logic.ts",
    "apps/web/src/lib/use-query-view.ts",
  ],
  summary:
    "useQueryView separates pending reads, initial errors with retry, successful empty results and cached items with refetch errors. The query-data-requires-state lint rule rejects data reads without state handling and hooks that discard query state; its exact-set baseline only shrinks.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
