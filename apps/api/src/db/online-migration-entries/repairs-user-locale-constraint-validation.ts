import type { OnlineMigrationEntry } from "../online-migration-entry";
import { USER_LOCALE_CONSTRAINT_VALIDATION } from "../user-locale-constraint-validation";

export default {
  id: "repairs-user-locale-constraint-validation",
  revision: 1491,
  lifecycle: "pending",
  type: "repairs",
  values: [USER_LOCALE_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
