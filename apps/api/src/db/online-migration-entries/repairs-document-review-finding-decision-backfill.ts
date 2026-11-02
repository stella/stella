import { DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL } from "../document-review-finding-decision-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-document-review-finding-decision-backfill",
  revision: 1200,
  type: "repairs",
  values: [DOCUMENT_REVIEW_FINDING_DECISION_BACKFILL],
} satisfies OnlineMigrationEntry;
