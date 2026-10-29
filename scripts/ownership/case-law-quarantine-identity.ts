import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-quarantine-identity",
  capability:
    "The identity of a listed case-law record that states no usable publisher id",
  owner: ["apps/api/src/lib/legal-search/quarantine-identity.ts"],
  summary:
    "`quarantineIdentity` owns existing stable-field quarantine keys and bounded " +
    "repair aliases. `quarantinedListingObservation` owns a separate branded " +
    "source-and-fingerprint identity for SK-US and PL-courts listings without " +
    "usable stable fields, including unserved listing slots. These immutable " +
    "raw observations are stored in `case_law_listing_observations` before " +
    "crawl or reconciliation progress; they never enter canonical identity " +
    "matching or alias adoption.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
