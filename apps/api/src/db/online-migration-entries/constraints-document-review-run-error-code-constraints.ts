import { DOCUMENT_REVIEW_RUN_ERROR_CODE_CONSTRAINTS } from "../document-review-run-error-code-constraint-validation";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-document-review-run-error-code-constraints",
  revision: 1424,
  type: "constraints",
  values: [...DOCUMENT_REVIEW_RUN_ERROR_CODE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
