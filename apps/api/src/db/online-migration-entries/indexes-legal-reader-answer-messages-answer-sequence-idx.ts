import type { OnlineMigrationEntry } from "../online-migration-entry";
import {
  EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES,
  onlineUniqueIndexDefinition,
} from "../online-unique-indexes";

export default {
  id: "indexes-legal-reader-answer-messages-answer-sequence-idx",
  revision: 690,
  type: "indexes",
  values: [
    onlineUniqueIndexDefinition(
      EXECUTABLE_ONLINE_UNIQUE_INDEX_NAMES.LEGAL_READER_ANSWER_MESSAGES_ANSWER_SEQUENCE_IDX,
    ),
  ],
} satisfies OnlineMigrationEntry;
