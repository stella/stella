import type { OnlineMigrationEntry } from "../online-migration-entry";
import { USAGE_ACTION_TYPE_CONSTRAINTS } from "../usage-action-type-constraint-validation";

export default {
  id: "constraints-usage-action-type-constraints",
  revision: 1385,
  type: "constraints",
  values: [...USAGE_ACTION_TYPE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
