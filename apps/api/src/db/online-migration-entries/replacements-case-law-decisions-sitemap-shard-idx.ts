import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-sitemap-shard-idx",
  revision: 800,
  type: "replacements",
  values: [
    {
      introducedBy: "20261010212100_case_law_publication_filter",
      legacyName: "case_law_decisions_sitemap_shard_idx",
      replacementNames: ["case_law_decisions_sitemap_shard_published_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
