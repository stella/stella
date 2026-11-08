import { CLIENT_INVOICE_TENANT_KEY } from "../client-invoice-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-client-invoice-tenant-key",
  revision: 950,
  type: "repairs",
  values: [CLIENT_INVOICE_TENANT_KEY],
} satisfies OnlineMigrationEntry;
