import { DECISION_DATE_CEILING_CONSTRAINTS } from "../decision-date-ceiling-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-decision-date-ceiling-constraints",
  revision: 1280,
  type: "constraints",
  values: [...DECISION_DATE_CEILING_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
