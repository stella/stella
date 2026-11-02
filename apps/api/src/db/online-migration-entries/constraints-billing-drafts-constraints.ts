import { BILLING_DRAFTS_CONSTRAINTS } from "../billing-drafts-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-billing-drafts-constraints",
  revision: 1315,
  type: "constraints",
  values: [...BILLING_DRAFTS_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
