import { DECISION_DATE_CEILING_REPAIR } from "../decision-date-ceiling-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-decision-date-ceiling-repair",
  revision: 1030,
  type: "repairs",
  values: [DECISION_DATE_CEILING_REPAIR],
} satisfies OnlineMigrationEntry;
