import { toSafeId } from "@stll/api-contract/safe-id";

const THREAD_ID = toSafeId<"chatThread">(
  "019a0000-0000-7000-8000-000000000001",
);
const fixtureTime = new Date().toISOString();
export const dockedChatMessagePage = {
  activeTurnId: null,
  attachedFiles: { fileCount: 0, files: [] },
  forkProvenance: { type: "none" as const },
  messages: [
    {
      id: toSafeId<"chatMessage">("019a0000-0000-7000-8000-000000000002"),
      role: "assistant" as const,
      revision: 0,
      edited: false,
      createdAt: fixtureTime,
      parts: [
        { type: "text" as const, content: "Saved geometry test answer." },
      ],
    },
  ],
  olderCursor: null,
  contextMatterIds: [],
  lastActivityAt: fixtureTime,
  threadRevision: null,
  threadExists: true,
  usedAnonymization: false,
  webSearchAvailable: false,
  webSearchEnabled: false,
  model: null,
  reasoningEffort: null,
  context: {
    estimatedTokens: 0,
    triggerTokens: 0,
    cacheStableTokens: 0,
    summarizedMessageCount: 0,
    breakdown: {
      promptTokens: 0,
      toolTokens: 0,
      summaryTokens: 0,
      attachmentTokens: 0,
      conversationTokens: 0,
    },
  },
};
export const dockedChatFileThreadPage = {
  ...dockedChatMessagePage,
  threadId: THREAD_ID,
};
export const dockedChatTemplateThread = { threadId: THREAD_ID };
export const dockedChatSuggestedPrompts = { prompts: [] };
export const dockedChatTitle = { title: "Geometry fixture" };
