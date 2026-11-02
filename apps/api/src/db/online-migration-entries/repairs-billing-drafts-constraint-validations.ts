import { BILLING_DRAFTS_CONSTRAINT_VALIDATIONS } from "../billing-drafts-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-billing-drafts-constraint-validations",
  revision: 1065,
  type: "repairs",
  values: [...BILLING_DRAFTS_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
