import { toolDefinition } from "@tanstack/ai";
import type { AnyTextAdapter } from "@tanstack/ai";
import { panic } from "better-result";
import { asc, eq } from "drizzle-orm";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages } from "@/api/db/schema";
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
import type { SafeId } from "@/api/lib/branded-types";
import {
  createScriptedStreamResponse,
  createScriptedTextAdapter,
  drainResponse,
} from "@/api/tests/helpers/chat-round-trip";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A real approval round trip: `send-message` over the `chat()` loop, with one
// counted, approval-gated external tool and a provider scripted per request.

export const APPROVAL_TOOL_NAME = "mcp__external__delete";

/** Arguments the scripted provider passes to the approval-gated tool. */
export const approvalToolArguments = (name: string): string =>
  JSON.stringify({ name });

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

type InterruptResume = {
  interruptId: string;
  payload: unknown;
  status: "resolved";
}[];

export type ApprovalCall = Extract<ChatPart, { type: "tool-call" }> & {
  approval: { id: string; needsApproval: boolean };
};

export const createApprovalHarness = ({
  ids,
  safeDb,
  scopedDb,
  testDb,
}: {
  ids: TestIds;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  testDb: TestDatabase;
}) => {
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
    indexThread: async () => await Promise.resolve(undefined),
    loadExternalMcpTools: async () => {
      const close = async () => await Promise.resolve(undefined);
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
    loadWebSearchProviders: async () =>
      await Promise.resolve({
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
  type SendMessageCtx = Parameters<typeof sendMessage.handler>[0];

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
      createAuditRecorder: () => async () => await Promise.resolve(),
      getAccessibleWorkspaces: async () =>
        await Promise.resolve([
          { id: ids.wsA1, status: "active" },
          { id: ids.wsA2, status: "active" },
        ]),
      getActiveWorkspaceIds: async () =>
        await Promise.resolve([ids.wsA1, ids.wsA2]),
      getWorkspaceAccess: async () => await Promise.resolve(null),
      memberRole: { role: "owner" },
      orgAIConfig,
      pinServerValidatedWorkspaceId: () => false,
      promptCachingEnabled: false,
      recordAuditEvent: async () => await Promise.resolve(),
      request: new Request("http://localhost/v1/chat/send"),
      route: "/v1/chat/send",
      safeDb,
      scopedDb,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    });
  };

  /** A streamed response is drained so its terminal persistence runs; any
   *  other handler result is a rejection and is returned as-is for the
   *  assertion. */
  const send = async (
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

  const lastAssistant = async (threadId: SafeId<"chatThread">) => {
    const message = (await readThreadMessages(threadId)).findLast(
      ({ role }) => role === "assistant",
    );
    if (message === undefined) {
      return panic("Expected an assistant message");
    }
    return message;
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

  return {
    adapters,
    approveContext,
    executions,
    lastAssistant,
    readThreadMessages,
    send,
    sendContext,
  };
};

/** The approval-gated call among `parts` still waiting for its answer. */
export const pendingApprovalCallOf = (
  parts: readonly ChatPart[],
): ApprovalCall => {
  const call = parts.find(
    (part): part is ApprovalCall =>
      part.type === "tool-call" &&
      part.name === APPROVAL_TOOL_NAME &&
      "approval" in part &&
      part.state === "approval-requested",
  );
  if (call === undefined) {
    return panic("Expected a pending approval-gated tool call");
  }
  return call;
};
