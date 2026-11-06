import { ACCOUNT_AUDIT_CONSTRAINT_VALIDATION } from "../account-audit-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-account-audit-constraint-validation",
  revision: 940,
  type: "repairs",
  values: [ACCOUNT_AUDIT_CONSTRAINT_VALIDATION],
} satisfies OnlineMigrationEntry;
