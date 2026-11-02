import { CONTACT_VAT_ID_REPAIR } from "../contact-vat-id-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-contact-vat-id-repair",
  revision: 1140,
  type: "repairs",
  values: [CONTACT_VAT_ID_REPAIR],
} satisfies OnlineMigrationEntry;
