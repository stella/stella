// Declared apart from the runtime spec so the closed set of scoped transitions
// lists this identity explicitly, as it does the sanctions ones.
export const READER_ANSWER_TRANSITION_IDENTITIES = {
  READER_ANSWER_MESSAGE_TRANSITIONS: {
    tableName: "legalReaderAnswerMessages",
    key: "id",
    scope: [],
    stateColumn: "status",
  },
} as const;
