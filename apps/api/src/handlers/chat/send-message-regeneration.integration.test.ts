import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { CHAT_TURN_INTENT } from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const streamChatMock = mock(
  async () =>
    new Response("stream started", {
      headers: { "Content-Type": "text/event-stream" },
    }),
);
const loadExternalMcpToolsForTest = async () => {
  const close = async () => undefined;
  return {
    close,
    connectors: [],
    source: externalMcpToolsModule.createStellaMcpToolSource({
      closeClients: close,
      sourceTools: {},
    }),
    tools: {},
  };
};

const sendMessage = createSendMessage({
  indexThread: async () => undefined,
  loadExternalMcpTools: loadExternalMcpToolsForTest,
  loadWebSearchProviders: async () => ({
    urlFetcher: null,
    webSearchProvider: null,
  }),
  rollbackSideEffects: rollbackUnpersistedChatSideEffects,
  streamResponse: streamChatMock,
  uploadMessageFiles: uploadMessageFilesWithRollback,
});
type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

const orgAIConfig = {
  providers: [{ provider: "openai", apiKey: "test-api-key" }],
  overrideModels: {
    chat: { provider: "openai", modelId: "gpt-5.4-mini" },
    fast: { provider: "openai", modelId: "gpt-5.4-nano" },
    pdf: { provider: "openai", modelId: "gpt-5.4" },
    reasoning: { provider: "openai", modelId: "gpt-5.4" },
  },
} satisfies OrgAIConfig;

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const seedThread = async ({
  messages,
}: {
  messages: {
    id: SafeId<"chatMessage">;
    role: "assistant" | "user";
    text: string;
  }[];
}): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Regeneration integration test",
    userId: ids.userA1,
    workspaceId: null,
  });
  await testDb.insert(chatMessages).values(
    messages.map(({ id, role, text }, index) => ({
      content: toChatMessageContent({
        data: [{ content: text, type: "text" }],
        version: 2,
      }),
      createdAt: new Date(Date.parse("2026-08-03T12:00:00.000Z") + index),
      id,
      role,
      threadId,
      userId: ids.userA1,
      workspaceId: null,
    })),
  );
  return threadId;
};

const createContext = ({
  message,
  threadId,
}: {
  message: ChatSendRequest["message"];
  threadId: SafeId<"chatThread">;
}): SendMessageCtx => {
  const forwardedProps = {
    contextMatterIds: [],
    message,
    runId: `run-${message.id}`,
    sendMode: CHAT_SEND_MODE.rawOverride,
    threadId,
    turnIntent: CHAT_TURN_INTENT.regenerate,
  };
  return asTestRaw<SendMessageCtx>({
    body: {
      threadId,
      runId: forwardedProps.runId,
      state: {},
      messages: [message],
      tools: [],
      context: [],
      forwardedProps,
      data: forwardedProps,
    },
    createAuditRecorder: () => async () => {},
    getAccessibleWorkspaces: async () => [
      { id: ids.wsA1, status: "active" },
      { id: ids.wsA2, status: "active" },
    ],
    getActiveWorkspaceIds: async () => [ids.wsA1, ids.wsA2],
    getWorkspaceAccess: async () => null,
    memberRole: { role: "owner" },
    orgAIConfig,
    pinServerValidatedWorkspaceId: () => false,
    promptCachingEnabled: false,
    recordAuditEvent: async () => {},
    request: new Request("http://localhost/v1/chat/send"),
    route: "/v1/chat/send",
    safeDb,
    scopedDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
  });
};

describe("explicit chat regeneration", () => {
  test("replaces the stale assistant tail and claims a fresh turn", async () => {
    const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const staleAssistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const threadId = await seedThread({
      messages: [
        { id: userMessageId, role: "user", text: "Draft an NDA" },
        {
          id: staleAssistantMessageId,
          role: "assistant",
          text: "Old draft",
        },
      ],
    });

    streamChatMock.mockClear();
    const result = await sendMessage.handler(
      createContext({
        message: {
          id: userMessageId,
          parts: [{ content: "Draft an NDA", type: "text" }],
          role: "user",
        },
        threadId,
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);

    const messages = await testDb
      .select({ id: chatMessages.id, role: chatMessages.role })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    expect(messages).toEqual([{ id: userMessageId, role: "user" }]);

    const turns = await testDb
      .select({
        executionId: chatTurns.executionId,
        status: chatTurns.status,
        userMessageId: chatTurns.userMessageId,
      })
      .from(chatTurns)
      .where(eq(chatTurns.threadId, threadId));
    expect(turns).toHaveLength(1);
    expect(turns.at(0)).toMatchObject({
      status: "running",
      userMessageId,
    });
    expect(turns.at(0)?.executionId).not.toBeNull();
  });

  test("rejects regenerating an older user turn without deleting its tail", async () => {
    const olderUserMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const latestUserMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const threadId = await seedThread({
      messages: [
        { id: olderUserMessageId, role: "user", text: "First request" },
        { id: assistantMessageId, role: "assistant", text: "First answer" },
        { id: latestUserMessageId, role: "user", text: "Second request" },
      ],
    });

    streamChatMock.mockClear();
    const result = await sendMessage.handler(
      createContext({
        message: {
          id: olderUserMessageId,
          parts: [{ content: "First request", type: "text" }],
          role: "user",
        },
        threadId,
      }),
    );

    expect(result).toEqual({
      code: 409,
      response: { message: "Only the latest user turn can be regenerated" },
    });
    expect(streamChatMock).not.toHaveBeenCalled();
    expect(
      await testDb
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.threadId, threadId)),
    ).toHaveLength(3);
  });
});
