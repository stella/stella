import type { OnlineMigrationEntry } from "../online-migration-entry";
import { READER_ANSWER_CONSTRAINTS } from "../reader-answer-constraint-validation";

export default {
  id: "constraints-reader-answer-constraints",
  revision: 1340,
  type: "constraints",
  values: [...READER_ANSWER_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
