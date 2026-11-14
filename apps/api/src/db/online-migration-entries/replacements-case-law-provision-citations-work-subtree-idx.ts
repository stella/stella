import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-provision-citations-work-subtree-idx",
  revision: 890,
  type: "replacements",
  // The subtree ranges, now carrying the cited-by page's grouping keys.
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      legacyName: "case_law_provision_citations_work_subtree_idx",
      replacementNames: ["case_law_provision_citations_work_citing_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
