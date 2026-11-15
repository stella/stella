import { DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINT_VALIDATIONS } from "../desktop-runner-question-answers-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-desktop-runner-question-answers-constraint-validations",
  revision: 1207,
  type: "repairs",
  values: [...DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
