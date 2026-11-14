import { FALLBACK_DECISION_INDEXES } from "../../lib/case-law/fallback-decision-identity-index";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-fallback-decision-indexes",
  revision: 776,
  type: "indexes",
  values: [...FALLBACK_DECISION_INDEXES],
} satisfies OnlineMigrationEntry;
