import { MONITORING_SESSION_INDEXES } from "@/api/lib/synthetic-principal/indexes";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-monitoring-session-indexes",
  revision: 110,
  type: "indexes",
  values: [...MONITORING_SESSION_INDEXES],
} satisfies OnlineMigrationEntry;
