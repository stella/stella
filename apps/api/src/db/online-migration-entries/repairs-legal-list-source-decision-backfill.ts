import { LEGAL_LIST_SOURCE_DECISION_BACKFILL } from "../legal-list-source-decision-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-legal-list-source-decision-backfill",
  revision: 1201,
  type: "repairs",
  values: [LEGAL_LIST_SOURCE_DECISION_BACKFILL],
} satisfies OnlineMigrationEntry;
