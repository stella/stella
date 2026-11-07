import { DOCUMENT_REVIEW_RUN_ERROR_CODE_CONSTRAINT_VALIDATIONS } from "../document-review-run-error-code-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-document-review-run-error-code-constraint-validations",
  revision: 1423,
  type: "repairs",
  values: [...DOCUMENT_REVIEW_RUN_ERROR_CODE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
