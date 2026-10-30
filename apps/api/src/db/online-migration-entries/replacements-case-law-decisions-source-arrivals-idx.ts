import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-source-arrivals-idx",
  revision: 790,
  type: "replacements",
  values: [
    {
      introducedBy: "20261010212100_case_law_publication_filter",
      legacyName: "case_law_decisions_source_arrivals_idx",
      replacementNames: ["case_law_decisions_source_arrivals_published_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
