import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { agentSkills, chatMessages, chatThreads } from "@/api/db/schema";
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
import type { ChatPart } from "@/api/handlers/chat/types";
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
  decision: null,
} satisfies OrgAIConfig;

const INSTALLED_SKILL_SLUG = "installed-review-workflow";
const ASK_USER_CALL_ID = "ask-1";

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let scopedDb: ScopedDb;
const seededThreadIds: SafeId<"chatThread">[] = [];
const seededSkillIds: SafeId<"agentSkill">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedDb = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );
  safeDb = toSafeDbMock(scopedDb);

  const skillId = toSafeId<"agentSkill">(Bun.randomUUIDv7());
  seededSkillIds.push(skillId);
  await testDb.insert(agentSkills).values({
    id: skillId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    scope: "team",
    origin: "upload",
    slug: INSTALLED_SKILL_SLUG,
    name: INSTALLED_SKILL_SLUG,
    description: "Installed skill for continuation validation.",
    metadata: {},
    contentHash: "0".repeat(64),
    body: "Review the document.",
    enabled: true,
  });
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  if (seededSkillIds.length > 0) {
    await testDb
      .delete(agentSkills)
      .where(inArray(agentSkills.id, seededSkillIds));
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
  analysis: "Need jurisdiction",
  questions: [
    { question: "Which court?", reason: "Jurisdiction determines the law." },
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

const completedSkillCallParts = ({
  input,
  name,
  output,
}: {
  input: Record<string, string>;
  name: "load-skill" | "read-skill-resource";
  output: Record<string, unknown>;
}) =>
  [
    {
      arguments: JSON.stringify(input),
      id: `${name}-1`,
      input,
      name,
      output,
      state: "complete",
      type: "tool-call",
    },
    {
      content: JSON.stringify(output),
      state: "complete",
      toolCallId: `${name}-1`,
      type: "tool-result",
    },
  ] satisfies ChatPart[];

/** An assistant turn that ran skill tools and now awaits an `ask-user` answer. */
const seedAwaitingTurn = async (skillCallParts: ChatPart[]) => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Skill continuation test",
    userId: ids.userA1,
    workspaceId: null,
  });

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
            data: [{ content: "Review this", type: "text" }],
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
            data: [...skillCallParts, pendingAskUserCall],
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

const answerAskUser = async (skillCallParts: ChatPart[]) => {
  const { assistantMessageId, threadId } =
    await seedAwaitingTurn(skillCallParts);
  streamChatMock.mockClear();
  return await sendMessage.handler(
    createContext({
      message: {
        id: assistantMessageId,
        parts: [
          ...skillCallParts,
          {
            ...pendingAskUserCall,
            output: {
              answers: [
                {
                  answer: "Municipal Court in Prague",
                  question: "Which court?",
                },
              ],
            },
            state: "complete",
          },
        ],
        role: "assistant",
      },
      threadId,
    }),
  );
};

describe("continuing a turn that called skill tools", () => {
  test("accepts the continuation after a completed load-skill call", async () => {
    const result = await answerAskUser(
      completedSkillCallParts({
        input: { skillName: INSTALLED_SKILL_SLUG },
        name: "load-skill",
        output: {
          description: "Installed skill for continuation validation.",
          instructions: "Review the document.",
          name: INSTALLED_SKILL_SLUG,
          resources: [],
          version: "1.0",
        },
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
  });

  test("accepts the continuation after a completed read-skill-resource call", async () => {
    const result = await answerAskUser(
      completedSkillCallParts({
        input: {
          path: "knowledge/checklist.md",
          skillName: INSTALLED_SKILL_SLUG,
        },
        name: "read-skill-resource",
        output: {
          content: "Checklist",
          mimeType: "text/markdown",
          origin: "upload",
          path: "knowledge/checklist.md",
          skillId: "skill-id",
          skillName: INSTALLED_SKILL_SLUG,
        },
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
  });

  test("accepts a persisted call naming a skill that is no longer installed", async () => {
    const result = await answerAskUser(
      completedSkillCallParts({
        input: { skillName: "since-removed-workflow" },
        name: "load-skill",
        output: {
          description: "Removed after this call ran.",
          instructions: "Review the document.",
          name: "since-removed-workflow",
          resources: [],
          version: "1.0",
        },
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
  });

  test("accepts a settled persisted call to a tool no current set defines", async () => {
    const result = await answerAskUser(
      completedSkillCallParts({
        input: { skillName: INSTALLED_SKILL_SLUG },
        // Stands in for a tool renamed or removed since the call ran; the type
        // would otherwise exclude the name. Only the awaited call is judged
        // against this request's tools.
        name: asTestRaw<"load-skill">("load-skill-since-renamed"),
        output: {},
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
  });
});
