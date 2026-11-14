import { NOTIFICATION_TASK_ASSIGNED_CONSTRAINTS } from "../notification-task-assigned-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-notification-task-assigned-constraints",
  revision: 1387,
  type: "constraints",
  values: [...NOTIFICATION_TASK_ASSIGNED_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
