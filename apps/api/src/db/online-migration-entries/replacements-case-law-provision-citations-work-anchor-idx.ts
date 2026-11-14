import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-provision-citations-work-anchor-idx",
  revision: 870,
  type: "replacements",
  // A provision's citing rows are its whole subtree, which the exact-anchor
  // walks cannot seek under the database collation.
  values: [
    {
      introducedBy: "20260819110000_case_law_provision_citations",
      legacyName: "case_law_provision_citations_work_anchor_idx",
      replacementNames: ["case_law_provision_citations_work_citing_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
