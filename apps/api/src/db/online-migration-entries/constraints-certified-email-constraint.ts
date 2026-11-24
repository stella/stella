import { CERTIFIED_EMAIL_CONSTRAINT } from "../certified-email-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-certified-email-constraint",
  revision: 1582,
  lifecycle: "pending",
  type: "constraints",
  values: [CERTIFIED_EMAIL_CONSTRAINT],
} satisfies OnlineMigrationEntry;
