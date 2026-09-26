import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  RESOURCE_TYPE,
  resourceRef,
  toChatResourceHref,
} from "@stll/api-contract";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { toChatMessageContent } from "@/api/handlers/chat/chat-message-parts";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  settleChatTurnOnTx,
} from "@/api/handlers/chat/chat-turn-persistence";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CHAT_REF_ENCODING,
  type ChatRefContext,
} from "@/api/lib/chat/ref-token";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const streamChatMock = mock(
  async (_options: { messages: ChatMessage[] }) =>
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
  streamResponse: asTestRaw(streamChatMock),
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
  decision: null,
} satisfies OrgAIConfig;

const ASK_USER_CALL_ID = "ask-1";

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

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

const askUserInput = {
  analysis: "Two DPAs found",
  questions: [
    { question: "Which DPA?", reason: "Only one should calibrate the review." },
  ],
};

const pendingAskUserCall = {
  arguments: JSON.stringify(askUserInput),
  id: ASK_USER_CALL_ID,
  input: askUserInput,
  name: "ask-user",
  state: "input-complete",
  type: "tool-call",
} satisfies ChatPart;

// A code-mode result keeps the refs its script returned: nothing resolves
// them back to ids, so only the stored binding says what `ent_1` meant.
const listedPart = {
  content: "Listed: ent_1 (CloudStore DPA).",
  type: "text",
} satisfies ChatPart;

/**
 * A turn that showed the model `ent_1` for entity A and now awaits an
 * `ask-user` answer. The user message before it mentions entity B.
 */
const seedAwaitingTurn = async () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Ref continuation test",
    userId: ids.userA1,
    workspaceId: null,
  });

  const mentionHref = toChatResourceHref({
    type: RESOURCE_TYPE.ENTITY,
    resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: ids.entityA2 }),
    location: {
      type: "workspace",
      workspace: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: ids.wsA1 }),
    },
  });
  const refContext = {
    version: 2,
    refs: [
      {
        kind: "entity",
        ref: "ent_1",
        entity: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: ids.entityA1 }),
        workspace: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: ids.wsA1 }),
      },
    ],
    entities: [],
    unresolvedInputs: [],
    workspaceScope: [
      resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: ids.wsA1 }),
    ],
  } satisfies ChatRefContext;

  const acceptance = createChatTurnAcceptance({
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: null,
  });
  unwrap(
    await safeDb(async (tx) => {
      await tx.insert(chatMessages).values([
        {
          content: toChatMessageContent({
            data: [
              { content: `Compare with [B](${mentionHref})`, type: "text" },
            ],
            version: 2,
          }),
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: null,
        },
        {
          content: toChatMessageContent({
            data: [listedPart, pendingAskUserCall],
            metadata: {
              refContext,
              refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
            },
            version: 2,
          }),
          id: assistantMessageId,
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: null,
        },
      ]);
      expect(
        await insertChatTurnAcceptanceOnTx({ acceptance, tx }),
      ).toMatchObject({
        type: "accepted",
      });
    }),
  );
  const execution = unwrap(
    await claimChatTurnForExecution({
      acceptedTurnId: acceptance.id,
      incomingMessageId: userMessageId,
      incomingMessageRole: "user",
      organizationId: ids.orgA,
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: null,
    }),
  );
  if (execution === null) {
    throw new Error("Expected the accepted turn to be claimed");
  }
  unwrap(
    await safeDb(
      async (tx) =>
        await settleChatTurnOnTx({
          assistantMessageId,
          execution,
          outcome: {
            interaction: { toolCallId: ASK_USER_CALL_ID, type: "ask-user" },
            type: "awaiting-user",
          },
          tx,
        }),
    ),
  );
  return { assistantMessageId, threadId };
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

const messageText = (message: ChatMessage | undefined) =>
  (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("\n");

describe("chat refs across an interactive answer", () => {
  test("a new request keeps a stored ref's target and mints past it", async () => {
    const { assistantMessageId, threadId } = await seedAwaitingTurn();
    streamChatMock.mockClear();

    const result = await sendMessage.handler(
      createContext({
        message: {
          id: assistantMessageId,
          parts: [
            listedPart,
            {
              ...pendingAskUserCall,
              output: {
                answers: [{ answer: "CloudStore", question: "Which DPA?" }],
              },
              state: "complete",
            },
          ],
          role: "assistant",
        },
        threadId,
      }),
    );

    expect(result).toBeInstanceOf(Response);
    const messages = streamChatMock.mock.calls.at(0)?.[0].messages;
    // Entity B is re-minted from its stored id. It must not take `ent_1`,
    // which the model already holds for entity A.
    const userText = messageText(
      messages?.find((message) => message.role === "user"),
    );
    expect(userText).toContain("#stella-entity-ref=ent_2");
    expect(userText).not.toContain("#stella-entity-ref=ent_1");
    expect(
      messageText(messages?.find((message) => message.role === "assistant")),
    ).toContain("ent_1");
  });
});
