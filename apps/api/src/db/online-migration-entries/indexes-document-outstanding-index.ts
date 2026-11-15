import { DOCUMENT_OUTSTANDING_INDEX } from "@/api/lib/legal-search/sk-document-outstanding-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-document-outstanding-index",
  revision: 490,
  type: "indexes",
  values: [DOCUMENT_OUTSTANDING_INDEX],
} satisfies OnlineMigrationEntry;
