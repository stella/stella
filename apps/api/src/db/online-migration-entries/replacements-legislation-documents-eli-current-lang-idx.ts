import type { OnlineMigrationEntry } from "../online-migration-entry";
import { LEGISLATION_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "replacements-legislation-documents-eli-current-lang-idx",
  revision: 830,
  type: "replacements",
  values: [
    {
      introducedBy: LEGISLATION_UNIQUE_INDEXES[0].introducedBy,
      legacyName: "legislation_documents_eli_current_lang_idx",
      replacementNames: [
        "legislation_documents_publisher_identity_idx",
        "legislation_documents_legacy_current_lang_idx",
      ],
    },
  ],
} satisfies OnlineMigrationEntry;
