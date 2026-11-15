import { EMAIL_UNDELIVERABLE_CONSTRAINT_VALIDATION } from "../email-undeliverable-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-email-undeliverable-constraint-validation",
  revision: 1120,
  type: "repairs",
  values: [EMAIL_UNDELIVERABLE_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
