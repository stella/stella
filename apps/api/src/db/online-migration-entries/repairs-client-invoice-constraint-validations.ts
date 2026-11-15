import { CLIENT_INVOICE_CONSTRAINT_VALIDATIONS } from "../client-invoice-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-client-invoice-constraint-validations",
  revision: 970,
  type: "repairs",
  values: [...CLIENT_INVOICE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
