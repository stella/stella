import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  attachTerminalTurnOutcome,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

type StreamResponse = NonNullable<
  Parameters<typeof createSendMessage>[0]
>["streamResponse"];

/**
 * A generation whose only tool call fails the tool schema (`questions` must
 * hold at least one entry), exactly what the run hands `onFinish` after the
 * provider stream ended. The stream is already open by then, so whatever
 * `onFinish` throws never reaches the handler's response.
 */
const invalidAskUserInput = {
  analysis: "Nothing is known yet.",
  questions: [],
};

/**
 * The run calls `onFinish` once the provider stream has ended, long after the
 * handler returned the open response, so the mock settles the generation on a
 * later tick and hands the test what `onFinish` threw.
 */
let finishFailure: Promise<unknown> = Promise.resolve(undefined);
const streamChatMock = mock<StreamResponse>(async ({ onFinish }) => {
  finishFailure = new Promise((resolve) => {
    setTimeout(() => {
      void Promise.resolve()
        .then(async () => {
          await onFinish({
            outcome: { type: "completed" },
            responseMessage: attachTerminalTurnOutcome({
              message: toPersistableChatMessage({
                id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
                parts: [
                  {
                    arguments: JSON.stringify(invalidAskUserInput),
                    id: "ask-user-invalid",
                    input: invalidAskUserInput,
                    name: ASK_USER_TOOL_NAME,
                    state: "input-complete",
                    type: "tool-call",
                  },
                ],
                role: "assistant",
              }),
              turnOutcome: { type: "completed" },
            }),
          });
          return null;
        })
        .catch((error: unknown) => error)
        .then(resolve);
    }, 0);
  });
  return new Response("stream started", {
    headers: { "Content-Type": "text/event-stream" },
  });
});
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
  decision: null,
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

const seedEmptyThread = async (): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Turn settlement integration test",
    userId: ids.userA1,
    workspaceId: null,
  });
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

describe("settling a turn whose generation fails after the stream opened", () => {
  test("fails the turn when the generated tool parts do not meet their schema", async () => {
    const threadId = await seedEmptyThread();
    const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());

    streamChatMock.mockClear();
    const result = await sendMessage.handler(
      createContext({
        message: {
          id: userMessageId,
          parts: [{ content: "Build an NDA playbook", type: "text" }],
          role: "user",
        },
        threadId,
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    // The fixture reached the fault: the generation was rejected, and that
    // rejection is the one the stream turns into the client's run error.
    const failure = await finishFailure;
    expect(HandlerError.is(failure) ? failure.message : failure).toBe(
      "Generated chat tool parts are invalid",
    );

    // The turn is settled all the same, so the thread accepts the next send
    // instead of waiting out the lease of a run that already ended.
    const turns = await testDb
      .select({
        failureCode: chatTurns.failureCode,
        failureRetryable: chatTurns.failureRetryable,
        settledAt: chatTurns.settledAt,
        status: chatTurns.status,
      })
      .from(chatTurns)
      .where(eq(chatTurns.threadId, threadId));
    expect(turns).toHaveLength(1);
    expect(turns.at(0)).toMatchObject({
      failureCode: "internal",
      failureRetryable: true,
      status: "failed",
    });
    expect(turns.at(0)?.settledAt).not.toBeNull();
  });
});
