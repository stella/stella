export const RECORDED_CONVERSATION_SUITES = {
  protocol: "src/handlers/chat/recorded-conversations.integration.test.ts",
  lifecycle:
    "src/handlers/chat/recorded-conversations.lifecycle.integration.test.ts",
  // Each suite runs in its own test process; a suite whose scenarios outgrow
  // one process's memory budget splits into another suite here.
  interruptions:
    "src/handlers/chat/recorded-conversations.interruptions.integration.test.ts",
} as const;

export type RecordedConversationSuite =
  keyof typeof RECORDED_CONVERSATION_SUITES;
