import { NOTIFICATION_LOCAL_RUN_LIMIT_RESET_CONSTRAINTS } from "../notification-local-run-limit-reset-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-notification-local-run-limit-reset-constraints",
  revision: 1426,
  type: "constraints",
  values: [...NOTIFICATION_LOCAL_RUN_LIMIT_RESET_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
