import { COURT_ACTIVITY_ARRIVALS_INDEX } from "../case-law-court-activity-indexes";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-population-projection-arrivals-idx",
  revision: 1412,
  type: "indexes",
  values: [COURT_ACTIVITY_ARRIVALS_INDEX],
} satisfies OnlineMigrationEntry;
