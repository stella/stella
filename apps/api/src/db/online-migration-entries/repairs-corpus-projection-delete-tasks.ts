import { CORPUS_PROJECTION_DELETE_TASK_REPAIR } from "../corpus-projection-delete-task-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-delete-tasks",
  revision: 1493,
  lifecycle: "pending",
  type: "repairs",
  values: [CORPUS_PROJECTION_DELETE_TASK_REPAIR],
} satisfies OnlineMigrationEntry;
