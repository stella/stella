import { LOCAL_RUN_APPROVAL_CEILING_CONSTRAINT_VALIDATIONS } from "../local-run-approval-ceiling-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-local-run-approval-ceiling-constraint-validations",
  revision: 1423,
  type: "repairs",
  values: [...LOCAL_RUN_APPROVAL_CEILING_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
