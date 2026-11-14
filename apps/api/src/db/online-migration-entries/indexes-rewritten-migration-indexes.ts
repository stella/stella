import { PREVIOUS_FALLBACK_DECISION_INDEX } from "../../lib/case-law/fallback-decision-identity-constants";
import { REWRITTEN_MIGRATION_INDEXES } from "../../lib/db/migration-history";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-rewritten-migration-indexes",
  revision: 760,
  type: "indexes",
  // Historical migration receipts remain valid; the contract release retires
  // the docket-only fallback index through its replacement.
  values: REWRITTEN_MIGRATION_INDEXES.filter(
    ({ name }) => name !== PREVIOUS_FALLBACK_DECISION_INDEX,
  ),
} satisfies OnlineMigrationEntry;
