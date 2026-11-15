import { EMAIL_UNDELIVERABLE_CONSTRAINTS } from "../email-undeliverable-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-email-undeliverable-constraints",
  revision: 1370,
  type: "constraints",
  values: [...EMAIL_UNDELIVERABLE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
