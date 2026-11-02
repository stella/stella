import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import {
  CHAT_MESSAGE_EDIT_ERROR_CODE,
  CHAT_TURN_INTENT,
} from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatThreads,
  chatTurns,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import {
  chatMessageFromPersisted,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatSendRequest } from "@/api/handlers/chat/chat-schema";
import { authorizeChatUserMessageEdit } from "@/api/handlers/chat/edit-user-message";
import getMessages from "@/api/handlers/chat/messages/list";
import { createSendMessage } from "@/api/handlers/chat/send-message";
import { compactMessagesForContext } from "@/api/handlers/chat/send-message-compaction";
import {
  rollbackUnpersistedChatSideEffects,
  uploadMessageFilesWithRollback,
} from "@/api/handlers/chat/send-message-side-effects";
import * as externalMcpToolsModule from "@/api/handlers/chat/tools/external-mcp-tools";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import type { OrgAIConfig } from "@/api/lib/ai-config";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createChatStreamMock } from "@/api/tests/helpers/chat-stream-mock";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const streamChatMock = createChatStreamMock();
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
  compactMessagesForContext,
  createRefRegistry: createChatRefRegistry,
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

const CREATED_AT = Date.parse("2026-10-01T12:00:00.000Z");
/** A lease no test outlives, so a seeded running turn stays live. */
const LIVE_LEASE = new Date("2999-01-01T00:00:00.000Z");

type Member = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type Seeded = { id: SafeId<"chatMessage">; role: "assistant" | "user" };

const suite = (
  database: GatedTestDb,
  cleanUp: (step: () => Promise<void>) => void,
) => {
  const seedOrganization = async (): Promise<{
    owner: Member;
    colleague: Member;
  }> => {
    const organizationId = mintAuthProviderId<"organization">();
    const ownerId = mintAuthProviderId<"user">();
    const colleagueId = mintAuthProviderId<"user">();
    await database.insert(organization).values({
      createdAt: new Date(CREATED_AT),
      id: organizationId,
      name: "Edit fixture",
      slug: organizationId,
    });
    // A later member of an organization is admitted only once its access
    // state is recorded.
    await database.insert(organizationAccessStates).values({
      organizationId,
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
    });
    await database.insert(user).values(
      [ownerId, colleagueId].map((id) => ({
        email: `${id}@example.test`,
        id,
        name: "Edit fixture",
      })),
    );
    await database.insert(member).values(
      [ownerId, colleagueId].map((userId) => ({
        createdAt: new Date(CREATED_AT),
        id: mintAuthProviderIdValue(),
        organizationId,
        role: "member",
        userId,
      })),
    );
    cleanUp(async () => {
      await database
        .delete(chatThreads)
        .where(eq(chatThreads.organizationId, organizationId));
      await deleteOrganizationsForTest(database, [organizationId]);
      await database
        .delete(user)
        .where(inArray(user.id, [ownerId, colleagueId]));
    });
    return {
      colleague: { organizationId, userId: colleagueId },
      owner: { organizationId, userId: ownerId },
    };
  };

  /** A thread of `owner` holding `messages` in order, each with its text. */
  const seedThread = async (
    owner: Member,
    messages: readonly (Seeded & { text: string })[],
  ): Promise<SafeId<"chatThread">> => {
    const threadId = createSafeId<"chatThread">();
    await database.insert(chatThreads).values({
      id: threadId,
      organizationId: owner.organizationId,
      title: "Edit fixture",
      userId: owner.userId,
      workspaceId: null,
    });
    await database.insert(chatMessages).values(
      messages.map(({ id, role, text }, index) => ({
        content: toPersistedChatMessageContentV3({
          data: [{ content: text, type: "text" }],
        }),
        createdAt: new Date(CREATED_AT + index),
        id,
        role,
        threadId,
        userId: owner.userId,
        workspaceId: null,
      })),
    );
    return threadId;
  };

  /** A turn of `threadId` that runs on a live lease. */
  const seedRunningTurn = async (
    owner: Member,
    threadId: SafeId<"chatThread">,
    userMessageId: SafeId<"chatMessage">,
  ) => {
    await database.insert(chatTurns).values({
      executionId: Bun.randomUUIDv7(),
      id: createSafeId<"chatTurn">(),
      leaseExpiresAt: LIVE_LEASE,
      organizationId: owner.organizationId,
      status: "running",
      threadId,
      userId: owner.userId,
      userMessageId,
      workspaceId: null,
    });
  };

  const turn = (index: number) => {
    const userMessageId = createSafeId<"chatMessage">();
    const answerId = createSafeId<"chatMessage">();
    return [
      { id: userMessageId, role: "user", text: `Question ${String(index)}` },
      { id: answerId, role: "assistant", text: `Answer ${String(index)}` },
    ] as const;
  };

  const rlsSafeDb = (requester: Member): SafeDb =>
    createSafeDb(
      markRlsDatabase(database),
      [],
      requester.organizationId,
      requester.userId,
    );

  const editContext = ({
    requester,
    targetMessageId,
    text,
    threadId,
  }: {
    requester: Member;
    targetMessageId: SafeId<"chatMessage">;
    text: string;
    threadId: SafeId<"chatThread">;
  }): SendMessageCtx => {
    const message: ChatSendRequest["message"] = {
      id: targetMessageId,
      parts: [{ content: `<p>${text}</p>`, type: "text" }],
      role: "user",
    };
    const forwardedProps = {
      contextMatterIds: [],
      message,
      runId: `run-${createSafeId<"chatTurn">()}`,
      sendMode: CHAT_SEND_MODE.rawOverride,
      threadId,
      truncateAfterMessageId: targetMessageId,
      turnIntent: CHAT_TURN_INTENT.edit,
    };
    return asTestRaw<SendMessageCtx>({
      body: {
        context: [],
        data: forwardedProps,
        forwardedProps,
        messages: [message],
        runId: forwardedProps.runId,
        state: {},
        threadId,
        tools: [],
      },
      createAuditRecorder: () => async () => {},
      getAccessibleWorkspaces: async () => [],
      getActiveWorkspaceIds: async () => [],
      getWorkspaceAccess: async () => null,
      managedAIResidency: "eu" as const,
      memberRole: sessionMemberRole("member"),
      orgAIConfig,
      orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
      pinServerValidatedWorkspaceId: () => false,
      promptCachingEnabled: false,
      recordAuditEvent: async () => {},
      request: new Request("http://localhost/v1/chat"),
      route: "/v1/chat" satisfies ApiRoutePath,
      safeDb: rlsSafeDb(requester),
      scopedDb: asTestRaw<ScopedDb>(
        createScopedDb(
          markRlsDatabase(database),
          [],
          requester.organizationId,
          requester.userId,
        ),
      ),
      session: { activeOrganizationId: requester.organizationId },
      user: { id: requester.userId },
    });
  };

  /** The thread's stored rows in order, with each message's text. */
  const storedThread = async (threadId: SafeId<"chatThread">) => {
    const rows = await database
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      text: chatMessageFromPersisted(row)
        .parts.flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join(""),
    }));
  };

  /** The thread as the page reads it on reload. */
  const reloadedThread = async (
    requester: Member,
    threadId: SafeId<"chatThread">,
  ) => {
    const response = await getMessages.handler(
      asTestRaw<Parameters<typeof getMessages.handler>[0]>({
        getWorkspaceAccess: async () => null,
        memberRole: sessionMemberRole("member"),
        orgAIConfig: null,
        params: { threadId },
        query: {},
        request: new Request("http://localhost/v1/chat/threads/messages"),
        route: "/v1/chat/threads/:threadId/messages" satisfies ApiRoutePath,
        safeDb: rlsSafeDb(requester),
        session: { activeOrganizationId: requester.organizationId },
        user: { id: requester.userId },
      }),
    );
    if ("code" in response) {
      return panic(
        `The thread read refused the reload: ${String(response.code)}`,
      );
    }
    return response.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.parts
        .flatMap((part) => (part.type === "text" ? [part.content] : []))
        .join(""),
    }));
  };

  test("an edit of the second of three user turns keeps the first and replaces the rest", async () => {
    const { owner } = await seedOrganization();
    const [first, firstAnswer] = turn(1);
    const [second, secondAnswer] = turn(2);
    const [third, thirdAnswer] = turn(3);
    const threadId = await seedThread(owner, [
      first,
      firstAnswer,
      second,
      secondAnswer,
      third,
      thirdAnswer,
    ]);

    streamChatMock.mockClear();
    const result = await sendMessage.handler(
      editContext({
        requester: owner,
        targetMessageId: second.id,
        text: "Question 2, edited",
        threadId,
      }),
    );

    expect(result).toBeInstanceOf(Response);
    expect(streamChatMock).toHaveBeenCalledTimes(1);
    const edited = [
      { id: first.id, role: "user" as const, text: "Question 1" },
      { id: firstAnswer.id, role: "assistant" as const, text: "Answer 1" },
      { id: second.id, role: "user" as const, text: "Question 2, edited" },
    ];
    expect(await storedThread(threadId)).toEqual(edited);
    // The new answer runs as the turn of the edited message.
    const turns = await database
      .select({
        status: chatTurns.status,
        userMessageId: chatTurns.userMessageId,
      })
      .from(chatTurns)
      .where(eq(chatTurns.threadId, threadId));
    expect(turns).toEqual([{ status: "running", userMessageId: second.id }]);
    // A reload shows exactly the edited history, never the dropped turns.
    expect(await reloadedThread(owner, threadId)).toEqual(edited);
  });

  describe("refuses an edit it may not make, leaving the thread as stored", () => {
    test("of another user's message", async () => {
      const { colleague, owner } = await seedOrganization();
      const [first, firstAnswer] = turn(1);
      const threadId = await seedThread(owner, [first, firstAnswer]);
      const before = await storedThread(threadId);

      streamChatMock.mockClear();
      const result = await sendMessage.handler(
        editContext({
          requester: colleague,
          targetMessageId: first.id,
          text: "Taken over",
          threadId,
        }),
      );

      expect(result).toMatchObject({
        code: 404,
        response: { code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing },
      });
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(await storedThread(threadId)).toEqual(before);
    });

    test("of a message of another thread", async () => {
      const { owner } = await seedOrganization();
      const [first, firstAnswer] = turn(1);
      const [other, otherAnswer] = turn(2);
      const threadId = await seedThread(owner, [first, firstAnswer]);
      const otherThreadId = await seedThread(owner, [other, otherAnswer]);
      const before = await storedThread(threadId);
      const otherBefore = await storedThread(otherThreadId);

      streamChatMock.mockClear();
      const result = await sendMessage.handler(
        editContext({
          requester: owner,
          targetMessageId: other.id,
          text: "Moved here",
          threadId,
        }),
      );

      expect(result).toMatchObject({
        code: 404,
        response: { code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing },
      });
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(await storedThread(threadId)).toEqual(before);
      expect(await storedThread(otherThreadId)).toEqual(otherBefore);
    });

    test("of a message an earlier edit already dropped", async () => {
      const { owner } = await seedOrganization();
      const [first, firstAnswer] = turn(1);
      const [dropped] = turn(2);
      const threadId = await seedThread(owner, [first, firstAnswer]);
      const before = await storedThread(threadId);

      streamChatMock.mockClear();
      const result = await sendMessage.handler(
        editContext({
          requester: owner,
          targetMessageId: dropped.id,
          text: "Stale edit",
          threadId,
        }),
      );

      expect(result).toMatchObject({
        code: 404,
        response: { code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing },
      });
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(await storedThread(threadId)).toEqual(before);
    });

    test("while a newer turn still runs", async () => {
      const { owner } = await seedOrganization();
      const [first, firstAnswer] = turn(1);
      const [running] = turn(2);
      const threadId = await seedThread(owner, [first, firstAnswer, running]);
      await seedRunningTurn(owner, threadId, running.id);
      const before = await storedThread(threadId);

      streamChatMock.mockClear();
      const result = await sendMessage.handler(
        editContext({
          requester: owner,
          targetMessageId: first.id,
          text: "Edited mid-turn",
          threadId,
        }),
      );

      expect(result).toMatchObject({
        code: 409,
        response: { code: CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning },
      });
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(await storedThread(threadId)).toEqual(before);
    });

    test("when a turn starts between the authorization and the save", async () => {
      const { owner } = await seedOrganization();
      const [first, firstAnswer] = turn(1);
      const [second, secondAnswer] = turn(2);
      const threadId = await seedThread(owner, [
        first,
        firstAnswer,
        second,
        secondAnswer,
      ]);
      const before = await storedThread(threadId);
      // The authorization is the handler's first transaction; the turn
      // starts right after it, so only the save under the thread lock can
      // see it.
      const authorizedSafeDb = rlsSafeDb(owner);
      let transactions = 0;
      const racingSafeDb: SafeDb = async (operation, retry) => {
        const result = await authorizedSafeDb(operation, retry);
        transactions += 1;
        if (transactions === 1) {
          await seedRunningTurn(owner, threadId, second.id);
        }
        return result;
      };

      streamChatMock.mockClear();
      const result = await sendMessage.handler({
        ...editContext({
          requester: owner,
          targetMessageId: first.id,
          text: "Edited as a turn starts",
          threadId,
        }),
        safeDb: racingSafeDb,
      });

      expect(result).toEqual({
        code: 409,
        response: {
          code: CHAT_MESSAGE_EDIT_ERROR_CODE.turnRunning,
          message: "A chat turn started before the edit was saved",
        },
      });
      expect(streamChatMock).not.toHaveBeenCalled();
      expect(await storedThread(threadId)).toEqual(before);
    });

    test("of an answer", async () => {
      const { owner } = await seedOrganization();
      const [first, firstAnswer] = turn(1);
      const threadId = await seedThread(owner, [first, firstAnswer]);
      const before = await storedThread(threadId);

      const result = await sendMessage.handler(
        editContext({
          requester: owner,
          targetMessageId: firstAnswer.id,
          text: "Rewritten answer",
          threadId,
        }),
      );

      expect(result).toMatchObject({
        code: 409,
        response: { code: CHAT_MESSAGE_EDIT_ERROR_CODE.targetNotUserMessage },
      });
      expect(await storedThread(threadId)).toEqual(before);
    });
  });

  describe("the edit authorization holds without row security", () => {
    // A connection that bypasses row security sees every thread, so only the
    // authorization query's own predicates stand between a requester and
    // another user's history.
    const rootSafeDb = safeDbFromScoped(
      async (run) => await database.transaction(run),
    );

    test("for another user, another organization and another thread", async () => {
      const { colleague, owner } = await seedOrganization();
      const stranger = (await seedOrganization()).owner;
      const [first, firstAnswer] = turn(1);
      const [other, otherAnswer] = turn(2);
      const threadId = await seedThread(owner, [first, firstAnswer]);
      await seedThread(owner, [other, otherAnswer]);

      const authorize = async (
        requester: Member,
        targetMessageId: SafeId<"chatMessage">,
      ) =>
        await authorizeChatUserMessageEdit({
          organizationId: requester.organizationId,
          safeDb: rootSafeDb,
          targetMessageId,
          threadId,
          userId: requester.userId,
        });
      const refusalOf = (result: Awaited<ReturnType<typeof authorize>>) =>
        Result.isError(result) && "code" in result.error
          ? result.error.code
          : null;

      expect(Result.isOk(await authorize(owner, first.id))).toBe(true);
      expect(
        refusalOf(
          await authorize(
            { organizationId: owner.organizationId, userId: colleague.userId },
            first.id,
          ),
        ),
      ).toBe(CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing);
      expect(
        refusalOf(
          await authorize(
            {
              organizationId: stranger.organizationId,
              userId: owner.userId,
            },
            first.id,
          ),
        ),
      ).toBe(CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing);
      expect(refusalOf(await authorize(owner, other.id))).toBe(
        CHAT_MESSAGE_EDIT_ERROR_CODE.targetMissing,
      );
      expect(refusalOf(await authorize(owner, firstAnswer.id))).toBe(
        CHAT_MESSAGE_EDIT_ERROR_CODE.targetNotUserMessage,
      );
    });
  });
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("editing a user message (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("editing a user message (postgres)", () => {
    const { cleanUp, db } = openGatedTestDatabase(databaseUrl);
    suite(db, cleanUp);
  });
}
