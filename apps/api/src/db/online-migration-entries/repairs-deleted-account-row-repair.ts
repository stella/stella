import { DELETED_ACCOUNT_ROW_REPAIR } from "../deleted-account-row-repair";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-deleted-account-row-repair",
  revision: 1604,
  lifecycle: "pending",
  type: "repairs",
  values: [DELETED_ACCOUNT_ROW_REPAIR],
} satisfies OnlineMigrationEntry;
