import { CERTIFIED_EMAIL_CONSTRAINT_VALIDATION } from "../certified-email-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-certified-email-constraint-validation",
  revision: 1584,
  lifecycle: "pending",
  type: "repairs",
  values: [CERTIFIED_EMAIL_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
