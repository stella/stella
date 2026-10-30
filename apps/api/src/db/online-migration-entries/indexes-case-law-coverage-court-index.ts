import { CASE_LAW_COVERAGE_COURT_INDEX } from "@/api/lib/case-law/coverage-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-coverage-court-index",
  revision: 150,
  type: "indexes",
  values: [CASE_LAW_COVERAGE_COURT_INDEX],
} satisfies OnlineMigrationEntry;
