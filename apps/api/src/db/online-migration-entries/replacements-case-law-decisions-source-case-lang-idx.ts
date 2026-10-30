import type { OnlineMigrationEntry } from "../online-migration-entry";
import { ONLINE_UNIQUE_INDEX_NAMES } from "../online-unique-indexes";

export default {
  id: "replacements-case-law-decisions-source-case-lang-idx",
  revision: 860,
  type: "replacements",
  values: [
    {
      introducedBy: "20260731130000_decision_source_document_id",
      legacyName: "case_law_decisions_source_case_lang_idx",
      replacementNames: [
        ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_DECISIONS_SOURCE_DOCUMENT_IDX,
        ONLINE_UNIQUE_INDEX_NAMES.CASE_LAW_DECISIONS_SOURCE_CASE_LANG_NULL_IDX,
      ],
    },
  ],
} satisfies OnlineMigrationEntry;
