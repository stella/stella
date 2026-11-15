import { DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINTS } from "../desktop-runner-question-answers-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-desktop-runner-question-answers-constraints",
  revision: 1401,
  type: "constraints",
  values: [...DESKTOP_RUNNER_QUESTION_ANSWERS_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
