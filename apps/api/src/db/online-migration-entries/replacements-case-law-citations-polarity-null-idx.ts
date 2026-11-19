import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-citations-polarity-null-idx",
  revision: 1488,
  lifecycle: "pending",
  type: "replacements",
  // Keyed on a column every entry holds as NULL, so it answers neither an
  // id-ordered walk of the queue nor a count of it; the pending index does.
  values: [
    {
      introducedBy: "20261117140000_case_law_citations_polarity_pending_idx",
      legacyName: "case_law_citations_polarity_null_idx",
      replacementNames: ["case_law_citations_polarity_pending_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
