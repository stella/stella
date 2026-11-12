import { DESKTOP_RUNNER_BACKGROUND_TASKS_CONSTRAINTS } from "../desktop-runner-background-tasks-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-desktop-runner-background-tasks-constraints",
  revision: 1455,
  type: "constraints",
  values: [...DESKTOP_RUNNER_BACKGROUND_TASKS_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
