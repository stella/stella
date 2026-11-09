import { FIELDS_OWNER_CONSTRAINT_VALIDATIONS } from "../fields-owner-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-fields-owner-constraint-validations",
  revision: 1419,
  type: "repairs",
  values: [...FIELDS_OWNER_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
