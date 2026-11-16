import { FUNCTION_DEPENDENT_INDEX_REINDEXES } from "../function-dependent-index-reindex";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-function-dependent-index-reindexes",
  revision: 920,
  lifecycle: "finalized",
  type: "repairs",
  values: [...FUNCTION_DEPENDENT_INDEX_REINDEXES],
} satisfies OnlineMigrationEntry;
