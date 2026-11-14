import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  CHAT_TOOL_EXECUTOR,
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
} from "@stll/api-contract/chat";
import { SHOW_APP_TOOL_NAME } from "@stll/api-contract/stella-mcp-app";
import type { StellaMcpAppToolResult } from "@stll/api-contract/stella-mcp-app";

import { chatMessages } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import {
  normalizePersistedChatMessageContent,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { createCallChatMcpAppTool } from "@/api/handlers/chat/mcp-apps/call-tool";
import { toChatMessage } from "@/api/handlers/chat/stream-chat";
import { createVisualResourceOrigin } from "@/api/handlers/visual-sandbox/resource-origin";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createShowAppTool, createTurnAppLedger } from "./show-app-tool";

const ids = createTestIds();
let database: TestDatabase;

// timeout: seeding the shared RLS fixtures runs many inserts on a cold database
beforeAll(async () => {
  database = await getTestDb();
  await setupRlsTestData(database, ids);
}, 30_000);
afterAll(releaseTestDb);

const citationsRead = {
  toolName: "read_case_law_citations",
  call: {
    input: { decision_id: "decision-one", direction: "cites" },
    result: {
      structuredContent: {
        decisionId: "decision-one",
        direction: "cites",
        citations: [],
        nextCursor: null,
        doctrineAvailability: "unavailable",
      },
    },
  },
};

/**
 * The live half of one turn: the server runs `show_app` for a read it kept,
 * and the stream carries the tool call, its result and the app part the
 * tool emitted, as the chat stream does.
 */
const streamShowApp = async () => {
  const origin = createVisualResourceOrigin();
  const ledger = createTurnAppLedger();
  const appId = ledger.record(citationsRead) ?? panic("Read not kept");
  const tool = createShowAppTool({ ledger, origin });
  const execute =
    tool[SHOW_APP_TOOL_NAME].execute ?? panic("The app tool has no executor");
  const emitted: StreamChunk[] = [];
  const toolCallId = "show-app-call";
  const output = await Promise.resolve(
    execute(
      { app_id: appId },
      {
        toolCallId,
        emitCustomEvent: (name: string, value: unknown) => {
          emitted.push({ type: EventType.CUSTOM, name, value });
        },
      },
    ),
  );
  const chunks: StreamChunk[] = [
    { type: EventType.RUN_STARTED, runId: "run-1", threadId: "thread-1" },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-1",
      role: "assistant",
    },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: SHOW_APP_TOOL_NAME,
      metadata: {
        [CHAT_TOOL_EXECUTOR_METADATA_KEY]: CHAT_TOOL_EXECUTOR.server,
      },
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify({ app_id: appId }),
    },
    { type: EventType.TOOL_CALL_END, toolCallId },
    ...emitted,
    {
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: "assistant-1",
      content: JSON.stringify(output),
    },
    { type: EventType.RUN_FINISHED, runId: "run-1", threadId: "thread-1" },
  ];
  const processor = new StreamProcessor();
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  const live =
    processor.getMessages().findLast(({ role }) => role === "assistant") ??
    panic("The stream carried no answer");
  return { live, origin };
};

test("an app shown in a turn streams, stores and reloads as one part, and its bridge resolves", async () => {
  const { live, origin } = await streamShowApp();
  const liveApp =
    live.parts.find((part) => part.type === "ui-resource") ??
    panic("The stream carried no app");
  expect(liveApp).toMatchObject({ toolCallId: "show-app-call" });

  const messageId = createSafeId<"chatMessage">();
  const message =
    toChatMessage(live, origin) ?? panic("The answer kept no parts");
  const content = toPersistedChatMessageContentV3({
    data: toPersistableChatMessage({ ...message, id: messageId }).parts,
  });
  await database.insert(chatMessages).values({
    id: messageId,
    threadId: ids.chatThreadGlobalA1,
    userId: ids.userA1,
    workspaceId: null,
    role: "assistant",
    content,
  });
  const [row] = await database
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(eq(chatMessages.id, messageId), eq(chatMessages.userId, ids.userA1)),
    );
  const reloaded = normalizePersistedChatMessageContent(
    (row ?? panic("The answer was not stored")).content,
    messageId,
  ).parts;
  expect(reloaded.filter((part) => part.type === "ui-resource")).toEqual([
    liveApp,
  ]);

  // The stored part is the one the app's bridge finds for the member.
  const answered: StellaMcpAppToolResult = {
    content: [{ type: "text", text: "{}" }],
    structuredContent: {},
  };
  const reads: string[] = [];
  const bridge = createCallChatMcpAppTool({
    runRead: async ({ name }) => {
      reads.push(name);
      return await Promise.resolve(answered);
    },
  });
  const response = await bridge.handler(
    createTestHandlerContext<Parameters<typeof bridge.handler>[0]>({
      audit: NO_AUDIT,
      scopedDb: NO_DB,
      params: { threadId: ids.chatThreadGlobalA1, toolCallId: "show-app-call" },
      body: { name: "open_case_law_decision", arguments: {} },
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: createSafeDb(database, [], ids.orgA, ids.userA1),
      request: new Request("https://example.test/app-call", { method: "POST" }),
    }),
  );
  expect(response).toEqual(answered);
  expect(reads).toEqual(["open_case_law_decision"]);
});

test("an app part the turn did not mint is not stored", async () => {
  const { live } = await streamShowApp();
  const message =
    toChatMessage(live, createVisualResourceOrigin()) ??
    panic("The answer kept no parts");
  expect(message.parts.some((part) => part.type === "ui-resource")).toBe(false);
  expect(message.parts.some((part) => part.type === "tool-call")).toBe(true);
});
