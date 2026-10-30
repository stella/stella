import type { OnlineMigrationEntry } from "../online-migration-entry";
import { LEGISLATION_UNIQUE_INDEXES } from "../online-unique-indexes";

export default {
  id: "replacements-legislation-documents-eli-version-lang-idx",
  revision: 820,
  type: "replacements",
  values: [
    {
      introducedBy: LEGISLATION_UNIQUE_INDEXES[0].introducedBy,
      legacyName: "legislation_documents_eli_version_lang_idx",
      replacementNames: [
        "legislation_documents_work_version_lang_idx",
        "legislation_documents_publisher_identity_idx",
        "legislation_documents_legacy_version_lang_idx",
      ],
    },
  ],
} satisfies OnlineMigrationEntry;
