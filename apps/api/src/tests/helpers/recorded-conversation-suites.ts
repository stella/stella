export const RECORDED_CONVERSATION_SUITES = {
  protocol: "src/handlers/chat/recorded-conversations.integration.test.ts",
  lifecycle:
    "src/handlers/chat/recorded-conversations.lifecycle.integration.test.ts",
} as const;

export type RecordedConversationSuite =
  keyof typeof RECORDED_CONVERSATION_SUITES;
