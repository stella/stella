import type { OnlineMigrationEntry } from "../online-migration-entry";
import { READER_ANNOTATION_CONSTRAINT_VALIDATIONS } from "../reader-annotation-constraint-validation";

export default {
  id: "repairs-reader-annotation-constraint-validations",
  revision: 1080,
  type: "repairs",
  values: [...READER_ANNOTATION_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
