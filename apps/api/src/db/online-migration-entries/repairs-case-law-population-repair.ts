import { CASE_LAW_POPULATION_REPAIR } from "../case-law-population-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-case-law-population-repair",
  revision: 1203,
  type: "repairs",
  values: [CASE_LAW_POPULATION_REPAIR],
} satisfies OnlineMigrationEntry;
