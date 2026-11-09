import { NOTIFICATION_LOCAL_RUN_LIMIT_RESET_CONSTRAINT_VALIDATIONS } from "../notification-local-run-limit-reset-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-notification-local-run-limit-reset-constraint-validations",
  revision: 1427,
  type: "repairs",
  values: [...NOTIFICATION_LOCAL_RUN_LIMIT_RESET_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
