import { CORPUS_PROJECTION_DOCUMENT_LANGUAGE_CONSTRAINTS } from "../corpus-projection-document-language-constraints";
import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "constraints-corpus-projection-document-language-constraints",
  revision: 1494,
  lifecycle: "pending",
  type: "constraints",
  values: [...CORPUS_PROJECTION_DOCUMENT_LANGUAGE_CONSTRAINTS],
} satisfies OnlineMigrationEntry;
