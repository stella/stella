import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-projection-epoch-write",
  capability: "Advancing a decision's search-projection epoch",
  owner: [
    "apps/api/src/lib/legal-search/corpus-index-projection-desired-state.ts",
    "apps/api/src/lib/legal-search/corpus-index-projection-bootstrap.ts",
  ],
  summary:
    "The projection epoch orders a decision's projection desired-state changes and is written with the desired states it orders. It is bookkeeping no reader sees, so its owners keep the decision's `updated_at` when they write it (`CANONICAL_PROJECTION_EPOCH_KEEPS_FRESHNESS`).",
  enforcement: {
    kind: "table-column-write",
    specifiers: ["@/api/db/schema", "@/api/db/schema/case-law"],
    table: "caseLawDecisions",
    columns: ["projectionEpoch"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
