import type { OnlineMigrationEntry } from "../online-migration-entry";
import { TIME_ENTRY_SUBMITTED_CONSTRAINTS } from "../time-entry-submitted-constraint-validation";

export default {
  id: "constraints-time-entry-submitted-constraints",
  revision: 1380,
  type: "constraints",
  values: [...TIME_ENTRY_SUBMITTED_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
