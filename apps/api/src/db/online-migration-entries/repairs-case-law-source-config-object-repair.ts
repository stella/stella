import { CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR } from "../case-law-source-config-object-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-case-law-source-config-object-repair",
  revision: 1205,
  type: "repairs",
  values: [CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR],
} satisfies OnlineMigrationEntry;
