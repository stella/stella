import { NOTIFICATION_TASK_ASSIGNED_CONSTRAINT_VALIDATIONS } from "../notification-task-assigned-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-notification-task-assigned-constraint-validations",
  revision: 1137,
  type: "repairs",
  values: [...NOTIFICATION_TASK_ASSIGNED_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
