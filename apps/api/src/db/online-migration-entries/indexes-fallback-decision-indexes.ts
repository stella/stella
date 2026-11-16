import { FALLBACK_DECISION_NONUNIQUE_INDEXES } from "../../lib/case-law/fallback-decision-identity-index";
import type { OnlineMigrationEntry } from "../online-migration-entry";
import { FALLBACK_DECISION_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "indexes-fallback-decision-indexes",
  revision: 776,
  lifecycle: "pending",
  type: "indexes",
  values: [
    ...FALLBACK_DECISION_UNIQUE_INDEXES,
    ...FALLBACK_DECISION_NONUNIQUE_INDEXES,
  ],
} satisfies OnlineMigrationEntry;
