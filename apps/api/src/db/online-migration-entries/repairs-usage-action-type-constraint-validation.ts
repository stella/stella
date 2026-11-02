import type { OnlineMigrationEntry } from "../online-migration-entry";
import { USAGE_ACTION_TYPE_CONSTRAINT_VALIDATION } from "../usage-action-type-constraint-validation";

export default {
  id: "repairs-usage-action-type-constraint-validation",
  revision: 1135,
  type: "repairs",
  values: [USAGE_ACTION_TYPE_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
