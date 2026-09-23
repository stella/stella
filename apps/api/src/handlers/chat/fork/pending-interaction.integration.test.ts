import { toolDefinition } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import { createStellaMcpToolSource } from "@/api/handlers/chat/tools/external-mcp-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import type { ChatPart } from "@/api/handlers/chat/types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createScriptedStreamResponse,
  createScriptedTextAdapter,
  drainResponse,
} from "@/api/tests/helpers/chat-round-trip";
import { findUnownedPendingInteractions } from "@/api/tests/helpers/chat-thread-invariants";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { createForkThread } from "./create";

// A fork copies history but not turn ownership (`chat_turns`). This suite runs
// a real approval round trip — the `chat()` loop pausing on an approval-gated
// tool, persisted through `send-message` — then forks the thread at that
// pending answer and answers the approval on both threads.

const APPROVAL_TOOL_NAME = "mcp__external__delete";
const APPROVAL_TOOL_ARGUMENTS = JSON.stringify({ name: "NDA" });

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

/** A send-message handler whose tool set carries one counted, approval-gated
 *  external tool, and whose provider answers from a per-request script. */
const createApprovalHarness = () => {
  const executions: string[] = [];
  const approvalTool = toolDefinition({
    name: APPROVAL_TOOL_NAME,
    description: "Server tool behind an approval",
    inputSchema: toTanStackToolSchema(v.object({ name: v.string() })),
    needsApproval: true,
  }).server(async ({ name }) => {
    executions.push(name);
    return await Promise.resolve({ deleted: name });
  });
  const adapters: AnyTextAdapter[] = [];
  const sendMessage = createSendMessage({
    indexThread: async () => undefined,
    loadExternalMcpTools: async () => {
      const close = async () => undefined;
      return await Promise.resolve({
        close,
        connectors: [],
        source: createStellaMcpToolSource({
          closeClients: close,
          sourceTools: {},
        }),
        tools: { [APPROVAL_TOOL_NAME]: approvalTool },
      });
    },
    loadWebSearchProviders: async () => ({
      urlFetcher: null,
      webSearchProvider: null,
    }),
    rollbackSideEffects: rollbackUnpersistedChatSideEffects,
    streamResponse: createScriptedStreamResponse(
      () =>
        adapters.shift() ??
        createScriptedTextAdapter([
          { finishReason: "stop", text: "Unscripted request", type: "text" },
        ]),
    ),
    uploadMessageFiles: uploadMessageFilesWithRollback,
  });
  return { adapters, executions, sendMessage };
};

type SendMessage = ReturnType<typeof createApprovalHarness>["sendMessage"];
type SendMessageCtx = Parameters<SendMessage["handler"]>[0];

type InterruptResume = {
  interruptId: string;
  payload: unknown;
  status: "resolved";
}[];

const sendContext = ({
  message,
  resume,
  runId,
  threadId,
}: {
  message: ChatSendRequest["message"];
  /** A continuation names the interrupted run it resumes. */
  resume?: { interruptedRunId: string; items: InterruptResume } | undefined;
  runId: string;
  threadId: SafeId<"chatThread">;
}): SendMessageCtx => {
  const continuation =
    resume === undefined
      ? {}
      : { parentRunId: resume.interruptedRunId, resume: resume.items };
  const forwardedProps = {
    contextMatterIds: [],
    message,
    runId,
    sendMode: CHAT_SEND_MODE.rawOverride,
    threadId,
    ...continuation,
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
      ...continuation,
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

/** A streamed response is drained so its terminal persistence runs; any other
 *  handler result is a rejection and is returned as-is for the assertion. */
const send = async (
  sendMessage: SendMessage,
  ctx: SendMessageCtx,
): Promise<
  { status: "streamed" } | { rejection: unknown; status: "rejected" }
> => {
  const result = await sendMessage.handler(ctx);
  if (result instanceof Response && result.ok) {
    await drainResponse(result);
    return { status: "streamed" };
  }
  return { rejection: result, status: "rejected" };
};

const readThreadMessages = async (threadId: SafeId<"chatThread">) =>
  (
    await testDb
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
  ).map(chatMessageFromPersisted);

type ApprovalCall = Extract<ChatPart, { type: "tool-call" }> & {
  approval: { id: string; needsApproval: boolean };
};

const lastAssistant = async (threadId: SafeId<"chatThread">) => {
  const message = (await readThreadMessages(threadId)).findLast(
    ({ role }) => role === "assistant",
  );
  if (message === undefined) {
    throw new Error("Expected an assistant message");
  }
  return message;
};

const approvalCallOf = (parts: readonly ChatPart[]): ApprovalCall => {
  const call = parts.find(
    (part): part is ApprovalCall =>
      part.type === "tool-call" &&
      part.name === APPROVAL_TOOL_NAME &&
      "approval" in part,
  );
  if (call === undefined) {
    throw new Error("Expected the approval-gated tool call");
  }
  return call;
};

/** The continuation a chat client posts when the user approves `call`. */
const approveContext = ({
  call,
  interruptedRunId,
  messageId,
  parts,
  threadId,
}: {
  call: ApprovalCall;
  interruptedRunId: string;
  messageId: SafeId<"chatMessage">;
  parts: readonly ChatPart[];
  threadId: SafeId<"chatThread">;
}): SendMessageCtx =>
  sendContext({
    message: {
      id: messageId,
      parts: parts.map((part) =>
        part.type === "tool-call" && part.id === call.id
          ? {
              ...call,
              approval: { ...call.approval, approved: true },
              state: "approval-responded",
            }
          : part,
      ),
      role: "assistant",
    },
    resume: {
      interruptedRunId,
      items: [
        {
          interruptId: call.approval.id,
          payload: { approved: true },
          status: "resolved",
        },
      ],
    },
    runId: `run-${Bun.randomUUIDv7()}`,
    threadId,
  });

describe("forking a thread at a pending approval", () => {
  test("the fork carries no answerable approval, and the approved tool runs once, on the source thread", async () => {
    const { adapters, executions, sendMessage } = createApprovalHarness();
    const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(threadId);
    const firstRunId = `run-${Bun.randomUUIDv7()}`;

    adapters.push(
      createScriptedTextAdapter([
        {
          arguments: APPROVAL_TOOL_ARGUMENTS,
          toolName: APPROVAL_TOOL_NAME,
          type: "tool-call",
        },
      ]),
    );
    expect(
      await send(
        sendMessage,
        sendContext({
          message: {
            id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
            parts: [{ content: "Delete the NDA", type: "text" }],
            role: "user",
          },
          runId: firstRunId,
          threadId,
        }),
      ),
    ).toEqual({ status: "streamed" });

    const pending = await lastAssistant(threadId);
    const pendingCall = approvalCallOf(pending.parts);
    // The fixture must reach the fault: the source thread's answer is a live
    // approval owned by its awaiting turn.
    expect(pendingCall.state).toBe("approval-requested");
    expect(
      await findUnownedPendingInteractions({ db: testDb, threadId }),
    ).toEqual([]);

    const forkThreadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
    seededThreadIds.push(forkThreadId);
    const forked = await createForkThread({
      indexChatThread: async () => undefined,
    }).handler(
      asTestRaw<Parameters<ReturnType<typeof createForkThread>["handler"]>[0]>({
        body: { newThreadId: forkThreadId, upToMessageId: pending.id },
        getWorkspaceAccess: async () => null,
        memberRole: { role: "owner" },
        params: { threadId },
        query: {},
        recordAuditEvent: async () => undefined,
        request: new Request("http://localhost/v1/chat/threads/fork"),
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
      }),
    );
    expect(forked).toMatchObject({ threadId: forkThreadId });

    expect(
      await findUnownedPendingInteractions({
        db: testDb,
        threadId: forkThreadId,
      }),
    ).toEqual([]);

    // Approve on the source thread: the loop executes the tool, then answers.
    adapters.push(
      createScriptedTextAdapter([
        { finishReason: "stop", text: "Deleted.", type: "text" },
      ]),
    );
    expect(
      await send(
        sendMessage,
        approveContext({
          call: pendingCall,
          interruptedRunId: firstRunId,
          messageId: pending.id,
          parts: pending.parts,
          threadId,
        }),
      ),
    ).toEqual({ status: "streamed" });
    expect(executions).toEqual(["NDA"]);

    // The same approval, answered on the fork, is not a resumable interaction.
    const forkAnswer = await lastAssistant(forkThreadId);
    adapters.push(
      createScriptedTextAdapter([
        { finishReason: "stop", text: "Deleted again.", type: "text" },
      ]),
    );
    const forkResult = await send(
      sendMessage,
      approveContext({
        call: pendingCall,
        interruptedRunId: firstRunId,
        messageId: forkAnswer.id,
        parts: pending.parts,
        threadId: forkThreadId,
      }),
    );
    expect({ executions, fork: forkResult.status }).toEqual({
      executions: ["NDA"],
      fork: "rejected",
    });
  });
});
