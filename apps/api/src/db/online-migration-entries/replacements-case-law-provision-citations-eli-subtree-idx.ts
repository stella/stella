import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-provision-citations-eli-subtree-idx",
  revision: 900,
  type: "replacements",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      legacyName: "case_law_provision_citations_eli_subtree_idx",
      replacementNames: ["case_law_provision_citations_eli_citing_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
