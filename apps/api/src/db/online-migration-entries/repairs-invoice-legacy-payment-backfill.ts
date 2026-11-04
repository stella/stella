import { INVOICE_LEGACY_PAYMENT_BACKFILL } from "@/api/lib/billing/invoice-payment-backfill";

import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-invoice-legacy-payment-backfill",
  revision: 1160,
  type: "repairs",
  values: [INVOICE_LEGACY_PAYMENT_BACKFILL],
} satisfies OnlineMigrationEntry;
