import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-search-candidate-idx",
  revision: 810,
  type: "replacements",
  values: [
    {
      introducedBy: "20261010212100_case_law_publication_filter",
      legacyName: "case_law_decisions_search_candidate_idx",
      replacementNames: ["case_law_decisions_search_candidate_published_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
