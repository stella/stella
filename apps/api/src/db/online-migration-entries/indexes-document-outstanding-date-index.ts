import { DOCUMENT_OUTSTANDING_DATE_INDEX } from "@/api/lib/legal-search/sk-document-outstanding-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-document-outstanding-date-index",
  revision: 500,
  type: "indexes",
  values: [DOCUMENT_OUTSTANDING_DATE_INDEX],
} satisfies OnlineMigrationEntry;
