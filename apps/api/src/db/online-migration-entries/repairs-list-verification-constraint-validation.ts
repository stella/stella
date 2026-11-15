import { LIST_VERIFICATION_CONSTRAINT_VALIDATION } from "../list-verification-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-list-verification-constraint-validation",
  revision: 1060,
  type: "repairs",
  values: [LIST_VERIFICATION_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
