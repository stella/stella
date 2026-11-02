import { INVOICE_SENT_AT_BACKFILL } from "@/api/lib/billing/invoice-payment-backfill";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-invoice-sent-at-backfill",
  revision: 1150,
  type: "repairs",
  values: [INVOICE_SENT_AT_BACKFILL],
} satisfies OnlineMigrationEntry;
