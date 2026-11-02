import type { OnlineMigrationEntry } from "../online-migration-entry";
import { CLIENT_INVOICE_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "indexes-client-invoice-unique-indexes",
  revision: 390,
  type: "indexes",
  values: [...CLIENT_INVOICE_UNIQUE_INDEXES],
} satisfies OnlineMigrationEntry;
