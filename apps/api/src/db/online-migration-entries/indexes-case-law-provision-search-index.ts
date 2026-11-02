import { CASE_LAW_PROVISION_SEARCH_INDEX } from "@/api/lib/case-law/provision-search-index";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-provision-search-index",
  revision: 245,
  type: "indexes",
  values: [CASE_LAW_PROVISION_SEARCH_INDEX],
} satisfies OnlineMigrationEntry;
