import { INVOICE_LANGUAGE_CONSTRAINTS } from "../invoice-language-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-invoice-language-constraints",
  revision: 1350,
  type: "constraints",
  values: [...INVOICE_LANGUAGE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
