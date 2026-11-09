import { CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR } from "../corpus-projection-delete-receipt-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-delete-receipt-repair",
  revision: 1040,
  type: "repairs",
  values: [CORPUS_PROJECTION_DELETE_RECEIPT_REPAIR],
} satisfies OnlineMigrationEntry;
