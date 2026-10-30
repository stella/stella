import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  LEGISLATION_UNIQUE_INDEXES,
  ONLINE_UNIQUE_INDEX_NAMES,
} from "../online-unique-indexes";

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
        ONLINE_UNIQUE_INDEX_NAMES.LEGISLATION_DOCUMENTS_PUBLISHER_IDENTITY_IDX,
        ONLINE_UNIQUE_INDEX_NAMES.LEGISLATION_DOCUMENTS_LEGACY_VERSION_LANG_IDX,
      ],
    },
  ],
} satisfies OnlineMigrationEntry;
