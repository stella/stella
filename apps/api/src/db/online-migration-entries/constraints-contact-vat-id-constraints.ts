import { CONTACT_VAT_ID_CONSTRAINTS } from "../contact-vat-id-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-contact-vat-id-constraints",
  revision: 1388,
  type: "constraints",
  values: [...CONTACT_VAT_ID_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
