import type { OnlineMigrationEntry } from "../online-migration-entry";
import { ONLINE_UNIQUE_INDEX_NAMES } from "../online-unique-indexes";

export default {
  id: "replacements-legal-reader-answer-messages-answer-idx",
  revision: 840,
  type: "replacements",
  values: [
    {
      introducedBy: "20261010212300_reader_answer_message_sequence",
      legacyName: "legal_reader_answer_messages_answer_idx",
      replacementNames: [
        ONLINE_UNIQUE_INDEX_NAMES.LEGAL_READER_ANSWER_MESSAGES_ANSWER_SEQUENCE_IDX,
      ],
    },
  ],
} satisfies OnlineMigrationEntry;
