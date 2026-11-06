import { PREVIOUS_FALLBACK_DECISION_INDEX } from "../../lib/case-law/fallback-decision-identity-constants";
import { REWRITTEN_MIGRATION_INDEXES } from "../../lib/db/migration-history";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-rewritten-migration-indexes",
  revision: 760,
  type: "indexes",
  // Historical migration receipts remain valid; the obsolete fallback index
  // is no longer a current requirement and the contract phase retires it.
  values: REWRITTEN_MIGRATION_INDEXES.filter(
    ({ name }) => name !== PREVIOUS_FALLBACK_DECISION_INDEX,
  ),
} satisfies OnlineMigrationEntry;
