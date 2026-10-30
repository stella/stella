import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-quarantine-identity",
  capability:
    "The identity of a listed case-law record that states no usable publisher id",
  owner: [
    "apps/api/src/lib/legal-search/quarantine-identity.ts",
    "apps/api/src/lib/legal-search/quarantine-prefixes.ts",
    "apps/api/src/handlers/case-law/ingestion/quarantine-collision-filter.ts",
  ],
  summary:
    "`quarantineIdentity` owns existing stable-field quarantine keys and bounded " +
    "repair aliases. Pure shared prefix constants bind legacy producers to " +
    "quarantine classification. `quarantinedListingObservation` owns a separate branded " +
    "source-and-fingerprint identity for SK-US and PL-courts listings without " +
    "usable stable fields, including unserved listing slots. These immutable " +
    "raw observations are stored in `case_law_listing_observations` before " +
    "crawl or reconciliation progress; they never enter canonical identity " +
    "matching or alias adoption. The ingestion collision filter owns the opaque " +
    "decisions accepted by crawl and reconciliation writes, requiring a " +
    "complete reconciliation scope before retaining repair candidates.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
