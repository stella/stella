import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  LEGISLATION_UNIQUE_INDEXES,
  ONLINE_UNIQUE_INDEX_NAMES,
} from "../online-unique-indexes";

export default {
  id: "replacements-legislation-documents-eli-current-lang-idx",
  revision: 830,
  type: "replacements",
  values: [
    {
      introducedBy: LEGISLATION_UNIQUE_INDEXES[0].introducedBy,
      legacyName: "legislation_documents_eli_current_lang_idx",
      replacementNames: [
        ONLINE_UNIQUE_INDEX_NAMES.LEGISLATION_DOCUMENTS_PUBLISHER_IDENTITY_IDX,
        ONLINE_UNIQUE_INDEX_NAMES.LEGISLATION_DOCUMENTS_LEGACY_CURRENT_LANG_IDX,
      ],
    },
  ],
} satisfies OnlineMigrationEntry;
