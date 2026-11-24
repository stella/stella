import { MATTER_VISIBILITY_CONSTRAINT_VALIDATION } from "../matter-visibility-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-matter-visibility-constraint-validation",
  revision: 1602,
  lifecycle: "pending",
  type: "repairs",
  values: [MATTER_VISIBILITY_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
