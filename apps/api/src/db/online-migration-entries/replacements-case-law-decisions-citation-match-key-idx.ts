import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-citation-match-key-idx",
  revision: 1503,
  lifecycle: "pending",
  type: "replacements",
  // A partial index's expression has no statistics, so match-key comparisons
  // on decisions were estimated at the default selectivity; the full index
  // carries the same key and gives them real estimates.
  values: [
    {
      introducedBy: "20261120003000_case_number_match_key_full_index",
      legacyName: "case_law_decisions_citation_match_key_idx",
      replacementNames: ["case_law_decisions_citation_match_key_all_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
