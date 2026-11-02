import { CASE_LAW_REPLAY_PENDING_INDEX } from "../case-law-parsed-input-state";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-replay-pending-index",
  revision: 774,
  type: "indexes",
  values: [CASE_LAW_REPLAY_PENDING_INDEX],
} satisfies OnlineMigrationEntry;
