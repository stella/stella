import type { OnlineMigrationEntry } from "../online-migration-entry";
import { USER_LOCALE_CONSTRAINT } from "../user-locale-constraint-validation";

export default {
  id: "constraints-user-locale-constraints",
  revision: 1490,
  lifecycle: "pending",
  type: "constraints",
  values: [USER_LOCALE_CONSTRAINT],
} satisfies OnlineMigrationEntry;
