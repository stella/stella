import { CASE_LAW_COVERAGE_INDEX } from "@/api/lib/case-law/coverage-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-coverage-index",
  revision: 130,
  type: "indexes",
  values: [CASE_LAW_COVERAGE_INDEX],
} satisfies OnlineMigrationEntry;
