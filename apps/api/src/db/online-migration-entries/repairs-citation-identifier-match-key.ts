import { CITATION_IDENTIFIER_MATCH_KEY_BACKFILL } from "../citation-identifier-match-key-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

// After the pending index, which the repair walks and empties.
export default {
  id: "repairs-citation-identifier-match-key",
  revision: 1607,
  lifecycle: "pending",
  type: "repairs",
  values: [CITATION_IDENTIFIER_MATCH_KEY_BACKFILL],
} satisfies OnlineMigrationEntry;
