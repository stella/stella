import { LOCAL_RUN_APPROVAL_CEILING_CONSTRAINTS } from "../local-run-approval-ceiling-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-local-run-approval-ceiling-constraints",
  revision: 1422,
  type: "constraints",
  values: [...LOCAL_RUN_APPROVAL_CEILING_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
