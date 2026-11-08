import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-provision-citations-eli-anchor-idx",
  revision: 880,
  type: "replacements",
  values: [
    {
      introducedBy: "20260819130000_case_law_provision_citations_eli_idx",
      legacyName: "case_law_provision_citations_eli_anchor_idx",
      replacementNames: ["case_law_provision_citations_eli_citing_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
