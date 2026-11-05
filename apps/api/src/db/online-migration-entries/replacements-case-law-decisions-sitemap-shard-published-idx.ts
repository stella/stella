import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-sitemap-shard-published-idx",
  revision: 1415,
  type: "replacements",
  values: [
    {
      introducedBy: "20261105210000_case_law_sitemap_covering_indexes",
      legacyName: "case_law_decisions_sitemap_shard_published_idx",
      replacementNames: ["case_law_decisions_sitemap_month_published_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
