import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-source-case-lang-idx",
  revision: 860,
  type: "replacements",
  values: [
    {
      introducedBy: "20260731130000_decision_source_document_id",
      legacyName: "case_law_decisions_source_case_lang_idx",
      replacementNames: [
        "case_law_decisions_source_document_idx",
        "case_law_decisions_source_case_lang_null_idx",
      ],
    },
  ],
} satisfies OnlineMigrationEntry;
