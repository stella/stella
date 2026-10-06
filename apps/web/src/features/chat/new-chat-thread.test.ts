import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test } from "bun:test";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { DOCX_SUGGESTION_SURFACE } from "@stll/api-contract/chat-docx-suggestions";

import {
  getChatSendMode,
  setChatAnonymized,
  useChatAnonymizedStore,
} from "@/lib/chat-anonymized-store";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

import type {
  ChatRuntimeContextKind,
  ChatThreadOptionsContext,
} from "./chat-query-contract";
import { chatThreadOptions, seedNewChatThread } from "./queries";
import type { ChatThreadFetched } from "./queries";

const CONTEXTS = {
  plain: {},
  "active-file": {
    getActiveFile: () => ({
      entityId: "synthetic-file",
      fileName: "synthetic.docx",
    }),
  },
  "active-docx-edit": {
    getDocxSuggestionSurface: () => DOCX_SUGGESTION_SURFACE.fileOverlay,
  },
  "active-external": {
    getActiveExternal: () => ({
      title: "Synthetic publisher",
      url: "https://example.test/source",
    }),
  },
  "active-skill": { getActiveSkill: () => ({ skillName: "Synthetic skill" }) },
  "active-template": {
    getActiveTemplate: () => ({
      templateId: "synthetic-template",
      fileName: "synthetic.docx",
    }),
  },
} as const satisfies Record<ChatRuntimeContextKind, ChatThreadOptionsContext>;
const LEGAL_CONTEXTS = {
  decision: { getActiveDecision: () => ({ decisionId: "synthetic-decision" }) },
  statute: { getActiveStatute: () => ({ documentId: "synthetic-statute" }) },
  draft: {
    getActiveDraft: () => ({
      docxEditSnapshot: { blocks: [] },
      fileName: "draft.docx",
      originChatMessageId: "old-message",
      originChatThreadId: "old-thread",
      toolCallId: "old-tool",
    }),
  },
} as const satisfies Record<string, ChatThreadOptionsContext>;
const SCOPES = {
  global: (threadId: ChatThreadId) => ({ scope: "global", threadId }) as const,
  workspace: (threadId: ChatThreadId) =>
    ({
      scope: "workspace",
      threadId,
      workspaceId: "synthetic-matter",
    }) as const,
} satisfies Record<ChatThreadRef["scope"], (id: ChatThreadId) => ChatThreadRef>;
const originalModes = useChatAnonymizedStore.getState().sendModes;
afterEach(() => useChatAnonymizedStore.setState({ sendModes: originalModes }));

const previous = {
  activeTurnId: toSafeId<"chatTurn">("00000000-0000-4000-8000-000000000001"),
  attachedFiles: {
    fileCount: 1,
    files: [
      {
        id: "old-upload",
        kind: "document",
        mimeType: "application/pdf",
        name: "old-attachment.pdf",
        type: "upload",
      },
    ],
  },
  forkProvenance: {
    type: "parent",
    threadId: "source-thread",
    title: "Old conversation",
    workspaceId: "old-matter",
  },
  messages: [
    {
      id: "old-message",
      role: "user",
      parts: [{ type: "text", content: "Old privileged conversation" }],
    },
  ],
  olderCursor: "old-cursor",
  contextMatterIds: ["old-matter"],
  lastActivityAt: "2026-01-01T00:00:00.000Z",
  threadRevision: "old-revision",
  threadExists: true,
  usedAnonymization: true,
  webSearchAvailable: true,
  webSearchEnabled: true,
  model: "openai::synthetic-model",
  reasoningEffort: "high",
  context: {
    estimatedTokens: 15,
    triggerTokens: 100,
    cacheStableTokens: 6,
    summarizedMessageCount: 3,
    breakdown: {
      promptTokens: 3,
      toolTokens: 3,
      summaryTokens: 3,
      attachmentTokens: 3,
      conversationTokens: 3,
    },
  },
} satisfies ChatThreadFetched;

for (const [scope, ref] of Object.entries(SCOPES)) {
  for (const [surface, context] of Object.entries({
    ...CONTEXTS,
    ...LEGAL_CONTEXTS,
  })) {
    for (const mode of Object.values(CHAT_SEND_MODE)) {
      test(`${scope}/${surface}/${mode}: fresh drafts carry settings into only their exact capability key`, () => {
        const queryClient = new QueryClient();
        const previousKey = ref(toChatThreadId("previous-thread"));
        const key = ref(toChatThreadId("fresh-thread"));
        const contextMatterIds = ["selected-matter-A", "selected-matter-B"];
        setChatAnonymized(previousKey, mode === CHAT_SEND_MODE.anonymized);
        const options = chatThreadOptions({
          activeOrganizationId: "synthetic-org",
          context,
          key,
        });
        const oldOptions = chatThreadOptions({
          activeOrganizationId: "synthetic-org",
          context,
          key: previousKey,
        });
        queryClient.setQueryData(oldOptions.queryKey, previous);
        const seeded = seedNewChatThread({
          activeOrganizationId: "synthetic-org",
          context,
          key,
          queryClient,
          previousKey,
          contextMatterIds,
        });
        expect(seeded).toEqual({
          activeTurnId: null,
          attachedFiles: { fileCount: 0, files: [] },
          forkProvenance: { type: "none" },
          messages: [],
          olderCursor: null,
          contextMatterIds,
          lastActivityAt: null,
          threadRevision: null,
          threadExists: false,
          modelSelectionSource: "carried",
          usedAnonymization: false,
          webSearchAvailable: true,
          webSearchEnabled: false,
          model: previous.model,
          reasoningEffort: previous.reasoningEffort,
          context: null,
        });
        expect(getChatSendMode(key)).toBe(mode);
        const cachedDraft = queryClient.getQueryData(options.queryKey);
        const cachedSource = queryClient.getQueryData(oldOptions.queryKey);
        expect(cachedDraft).toBe(seeded);
        expect(cachedSource).toBe(previous);
        expect(
          queryClient
            .getQueryCache()
            .findAll()
            .map(({ queryKey }) => queryKey),
        ).toEqual([oldOptions.queryKey, options.queryKey]);
        const otherOrganizationDraft = queryClient.getQueryData(
          chatThreadOptions({
            activeOrganizationId: "other-org",
            context,
            key,
          }).queryKey,
        );
        expect(otherOrganizationDraft).toBeUndefined();
        const otherScope =
          scope === "global"
            ? SCOPES.workspace(key.threadId)
            : SCOPES.global(key.threadId);
        const otherScopeDraft = queryClient.getQueryData(
          chatThreadOptions({
            activeOrganizationId: "synthetic-org",
            context,
            key: otherScope,
          }).queryKey,
        );
        expect(otherScopeDraft).toBeUndefined();
        queryClient.clear();
      });
    }
  }
}

test("a fresh draft rejects the previous thread identity before changing cache or shield", () => {
  const queryClient = new QueryClient();
  const key = SCOPES.global(toChatThreadId("same-thread"));
  setChatAnonymized(key, false);
  expect(() =>
    seedNewChatThread({
      activeOrganizationId: "synthetic-org",
      context: {},
      key,
      queryClient,
      previousKey: key,
      contextMatterIds: [],
    }),
  ).toThrow("A fresh chat requires a distinct thread identity");
  expect(queryClient.getQueryCache().findAll()).toHaveLength(0);
  expect(getChatSendMode(key)).toBe(CHAT_SEND_MODE.rawOverride);
});

for (const threadExists of [false, true]) {
  test(`carried model metadata retains the actual row-exists state ${threadExists}`, () => {
    const queryClient = new QueryClient();
    const previousKey = SCOPES.global(toChatThreadId("old-template"));
    queryClient.setQueryData(
      chatThreadOptions({
        activeOrganizationId: "synthetic-org",
        context: CONTEXTS["active-template"],
        key: previousKey,
      }).queryKey,
      previous,
    );
    const data = seedNewChatThread({
      activeOrganizationId: "synthetic-org",
      context: CONTEXTS["active-template"],
      key: SCOPES.global(toChatThreadId("rotated-template")),
      queryClient,
      previousKey,
      contextMatterIds: ["selected-matter"],
      threadExists,
    });
    expect(data.threadExists).toBe(threadExists);
    expect(data.modelSelectionSource).toBe("carried");
    expect(data.model).toBe(previous.model);
    expect(data.reasoningEffort).toBe(previous.reasoningEffort);
    expect(data.messages).toEqual([]);
    queryClient.clear();
  });
}

test("fresh settings use the latest model PATCH cache write", () => {
  const queryClient = new QueryClient();
  const previousKey = SCOPES.global(toChatThreadId("model-source"));
  const context = CONTEXTS.plain;
  const oldOptions = chatThreadOptions({
    activeOrganizationId: "synthetic-org",
    context,
    key: previousKey,
  });
  queryClient.setQueryData(oldOptions.queryKey, previous);
  const persisted = {
    ...previous,
    model: "openai::updated-model",
    reasoningEffort: "low",
  } satisfies ChatThreadFetched;
  queryClient.setQueryData(oldOptions.queryKey, persisted);

  const seeded = seedNewChatThread({
    activeOrganizationId: "synthetic-org",
    context,
    key: SCOPES.global(toChatThreadId("model-destination")),
    previousKey,
    queryClient,
    contextMatterIds: [],
  });

  expect(seeded.model).toBe(persisted.model);
  expect(seeded.reasoningEffort).toBe(persisted.reasoningEffort);
  queryClient.clear();
});

test("missing canonical source metadata fails before changing cache or shield", () => {
  const queryClient = new QueryClient();
  const key = SCOPES.global(toChatThreadId("missing-source-destination"));
  setChatAnonymized(key, false);
  expect(() =>
    seedNewChatThread({
      activeOrganizationId: "synthetic-org",
      context: CONTEXTS.plain,
      key,
      previousKey: SCOPES.global(toChatThreadId("missing-source")),
      queryClient,
      contextMatterIds: [],
    }),
  ).toThrow("Fresh chat must carry settings from its cached source thread");
  expect(queryClient.getQueryCache().findAll()).toHaveLength(0);
  expect(getChatSendMode(key)).toBe(CHAT_SEND_MODE.rawOverride);
  queryClient.clear();
});
