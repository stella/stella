import { FILE_LIFECYCLE_CONSTRAINT_VALIDATIONS } from "../file-lifecycle-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-file-lifecycle-constraint-validations",
  revision: 1181,
  type: "repairs",
  values: [...FILE_LIFECYCLE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
