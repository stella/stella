import { DOCUMENT_OUTSTANDING_DATE_INDEX } from "@/api/lib/legal-search/sk-document-outstanding-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-case-law-decisions-document-pending-date-idx",
  revision: 850,
  type: "replacements",
  values: [
    {
      introducedBy: "20261003124500_public_law_reader_passage_counts",
      legacyName: "case_law_decisions_document_pending_date_idx",
      replacementNames: [DOCUMENT_OUTSTANDING_DATE_INDEX.name],
    },
  ],
} satisfies OnlineMigrationEntry;
