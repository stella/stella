import { LIST_CLAIM_ASSERTED_DATE_BACKFILL } from "../list-claim-asserted-date-backfill";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-list-claim-asserted-date-backfill",
  revision: 1453,
  type: "repairs",
  values: [LIST_CLAIM_ASSERTED_DATE_BACKFILL],
} satisfies OnlineMigrationEntry;
