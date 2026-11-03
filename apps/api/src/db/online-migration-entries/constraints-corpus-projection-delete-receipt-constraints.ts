import { CORPUS_PROJECTION_DELETE_RECEIPT_CONSTRAINTS } from "../corpus-projection-delete-receipt-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-corpus-projection-delete-receipt-constraints",
  revision: 1290,
  type: "constraints",
  values: [...CORPUS_PROJECTION_DELETE_RECEIPT_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
