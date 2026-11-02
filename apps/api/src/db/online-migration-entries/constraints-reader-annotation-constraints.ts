import type { OnlineMigrationEntry } from "../online-migration-entry";
import { READER_ANNOTATION_CONSTRAINTS } from "../reader-annotation-constraint-validation";

export default {
  id: "constraints-reader-annotation-constraints",
  revision: 1330,
  type: "constraints",
  values: [...READER_ANNOTATION_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
