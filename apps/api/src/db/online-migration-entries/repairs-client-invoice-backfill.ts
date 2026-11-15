import { CLIENT_INVOICE_BACKFILL } from "../client-invoice-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-client-invoice-backfill",
  revision: 960,
  type: "repairs",
  values: [CLIENT_INVOICE_BACKFILL],
} satisfies OnlineMigrationEntry;
