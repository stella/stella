import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legislation-projection-epoch-write",
  capability: "Advancing a legislation document's search-projection epoch",
  owner: [
    "apps/api/src/lib/legal-search/corpus-index-projection-desired-state.ts",
    "apps/api/src/lib/legal-search/corpus-index-projection-bootstrap.ts",
  ],
  summary:
    "The projection epoch orders a document's projection desired-state changes and is written with the desired states it orders. It is bookkeeping no reader sees, so its owners keep the document's `updated_at` when they write it (`CANONICAL_PROJECTION_EPOCH_KEEPS_FRESHNESS`).",
  enforcement: {
    kind: "table-column-write",
    specifiers: ["@/api/db/schema", "@/api/db/schema/legislation"],
    table: "legislationDocuments",
    columns: ["projectionEpoch"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
