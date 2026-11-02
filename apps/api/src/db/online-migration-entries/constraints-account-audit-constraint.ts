import { ACCOUNT_AUDIT_CONSTRAINT } from "../account-audit-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-account-audit-constraint",
  revision: 1210,
  type: "constraints",
  values: [ACCOUNT_AUDIT_CONSTRAINT],
} satisfies OnlineMigrationEntry;
