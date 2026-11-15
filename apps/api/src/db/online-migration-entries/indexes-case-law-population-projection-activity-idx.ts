import { COURT_ACTIVITY_LATEST_INDEX } from "../case-law-court-activity-indexes";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-population-projection-activity-idx",
  revision: 2,
  type: "indexes",
  values: [COURT_ACTIVITY_LATEST_INDEX],
} satisfies OnlineMigrationEntry;
