import { CASE_LAW_COURT_DATE_PUBLISHED_INDEX } from "@/api/lib/case-law/court-date-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-court-date-published-index",
  revision: 230,
  type: "indexes",
  values: [CASE_LAW_COURT_DATE_PUBLISHED_INDEX],
} satisfies OnlineMigrationEntry;
