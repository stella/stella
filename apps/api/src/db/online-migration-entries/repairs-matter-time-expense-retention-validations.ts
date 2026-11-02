import { MATTER_TIME_EXPENSE_RETENTION_VALIDATIONS } from "../matter-time-expense-retention-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-matter-time-expense-retention-validations",
  revision: 980,
  type: "repairs",
  values: [...MATTER_TIME_EXPENSE_RETENTION_VALIDATIONS],
} satisfies OnlineMigrationEntry;
