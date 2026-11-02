import { INVOICE_LANGUAGE_CONSTRAINT_VALIDATIONS } from "../invoice-language-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-invoice-language-constraint-validations",
  revision: 1100,
  type: "repairs",
  values: [...INVOICE_LANGUAGE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
