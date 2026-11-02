import type { OnlineMigrationEntry } from "../online-migration-entry";
import { READER_ANSWER_CONSTRAINT_VALIDATION } from "../reader-answer-constraint-validation";

export default {
  id: "repairs-reader-answer-constraint-validation",
  revision: 1090,
  type: "repairs",
  values: [READER_ANSWER_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
