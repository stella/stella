import { MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS } from "../matter-time-expense-retention-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-matter-time-expense-retention-constraints",
  revision: 1230,
  type: "constraints",
  values: [...MATTER_TIME_EXPENSE_RETENTION_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
