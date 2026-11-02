import type { OnlineMigrationEntry } from "../online-migration-entry";
import { TIME_ENTRY_SUBMITTED_CONSTRAINT_VALIDATION } from "../time-entry-submitted-constraint-validation";

export default {
  id: "repairs-time-entry-submitted-constraint-validation",
  revision: 1130,
  type: "repairs",
  values: [TIME_ENTRY_SUBMITTED_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
