import { CORPUS_PROJECTION_DOCUMENT_LANGUAGE_CONSTRAINT_VALIDATIONS } from "../corpus-projection-document-language-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "repairs-corpus-projection-document-language-constraint-validations",
  revision: 1495,
  lifecycle: "pending",
  type: "repairs",
  values: [...CORPUS_PROJECTION_DOCUMENT_LANGUAGE_CONSTRAINT_VALIDATIONS],
} satisfies OnlineMigrationEntry;
