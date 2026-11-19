import { CLIENT_INVOICE_CONSTRAINTS } from "../client-invoice-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-client-invoice-constraints",
  revision: 1220,
  lifecycle: "finalized",
  type: "constraints",
  values: [...CLIENT_INVOICE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
