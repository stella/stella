import { FILE_OBJECT_RECONCILIATION_REPAIR } from "../file-object-reconciliation-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-file-object-reconciliation-repair",
  revision: 1182,
  type: "repairs",
  values: [FILE_OBJECT_RECONCILIATION_REPAIR],
} satisfies OnlineMigrationEntry;
