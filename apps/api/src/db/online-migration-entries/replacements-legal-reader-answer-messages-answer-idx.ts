import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "replacements-legal-reader-answer-messages-answer-idx",
  revision: 840,
  type: "replacements",
  values: [
    {
      introducedBy: "20261010212300_reader_answer_message_sequence",
      legacyName: "legal_reader_answer_messages_answer_idx",
      replacementNames: ["legal_reader_answer_messages_answer_sequence_idx"],
    },
  ],
} satisfies OnlineMigrationEntry;
