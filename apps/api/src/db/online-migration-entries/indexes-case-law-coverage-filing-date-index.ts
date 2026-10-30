import { CASE_LAW_COVERAGE_FILING_DATE_INDEX } from "@/api/lib/case-law/coverage-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-coverage-filing-date-index",
  revision: 140,
  type: "indexes",
  values: [CASE_LAW_COVERAGE_FILING_DATE_INDEX],
} satisfies OnlineMigrationEntry;
