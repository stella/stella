import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-country-date-idx",
  revision: 780,
  type: "replacements",
  values: [
    {
      introducedBy: "20261010212100_case_law_publication_filter",
      legacyName: "case_law_decisions_country_date_idx",
      replacementNames: ["case_law_decisions_country_date_published_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
