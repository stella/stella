import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  getAwaitingUserInteractions,
  toChatMessageContent,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  finalizeAssistantTurn,
  persistFailedChatTurn,
} from "@/api/handlers/chat/chat-message-persistence";
import {
  CHAT_METERED_PROVIDER_TIMEOUT_MS,
  canAcceptChatTurnOnTx,
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  renewChatTurnExecutionLease,
  settleChatTurnOnTx,
  withClaimedChatTurnExecution,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecutionClaim } from "@/api/handlers/chat/chat-turn-persistence";
import { clientMessageFromPageRow } from "@/api/handlers/chat/message-page";
import type { ChatPart } from "@/api/handlers/chat/types";
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

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  safeDb = toSafeDbMock(asTestRaw<ScopedDb>(scoped));
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const seedThread = async () => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const userMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  const assistantMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);

  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Turn persistence test",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });

  return { assistantMessageId, threadId, userMessageId };
};

const unwrap = <T>(result: Result<T, unknown>): T => {
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

const awaitingAskUserContent = toChatMessageContent({
  data: [
    {
      arguments:
        '{"analysis":"Need jurisdiction","questions":[{"question":"Which court?","reason":"Jurisdiction determines the law."}]}',
      id: "ask-1",
      input: {
        analysis: "Need jurisdiction",
        questions: [
          {
            question: "Which court?",
            reason: "Jurisdiction determines the law.",
          },
        ],
      },
      name: "ask-user",
      state: "input-complete",
      type: "tool-call",
    },
  ] satisfies ChatPart[],
  version: 2,
});

const awaitingApprovalAndAskUserContent = toChatMessageContent({
  data: [
    {
      approval: { id: "approval-1", needsApproval: true },
      arguments: '{"query":"Draft"}',
      id: "approval-1",
      input: { query: "Draft" },
      name: "mcp__test__write",
      state: "approval-requested",
      type: "tool-call",
    },
    ...awaitingAskUserContent.data,
  ] satisfies ChatPart[],
  version: 2,
});

const seedAwaitingTurn = async () => {
  const { assistantMessageId, threadId, userMessageId } = await seedThread();
  const acceptance = createChatTurnAcceptance({
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId,
    workspaceId: ids.wsA1,
  });
  unwrap(
    await safeDb(async (tx) => {
      await tx.insert(chatMessages).values([
        {
          content: {
            data: [{ text: "Draft a response", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        },
        {
          content: awaitingAskUserContent,
          id: assistantMessageId,
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        },
      ]);
      expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(true);
    }),
  );
  const initialExecution = unwrap(
    await claimChatTurnForExecution({
      acceptedTurnId: acceptance.id,
      incomingMessageId: userMessageId,
      incomingMessageRole: "user",
      organizationId: ids.orgA,
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    }),
  );
  if (initialExecution === null) {
    throw new Error("Expected the accepted turn to be claimed");
  }
  unwrap(
    await safeDb(
      async (tx) =>
        await settleChatTurnOnTx({
          assistantMessageId,
          execution: initialExecution,
          outcome: {
            interaction: { toolCallId: "ask-1", type: "ask-user" },
            type: "awaiting-user",
          },
          tx,
        }),
    ),
  );
  return { acceptance, assistantMessageId, threadId, userMessageId };
};

describe("durable chat turn persistence", () => {
  test("terminalizes a failed continuation on its owning assistant", async () => {
    const { acceptance, assistantMessageId, threadId } =
      await seedAwaitingTurn();
    const execution = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: null,
        continuationInteraction: { toolCallId: "ask-1", type: "ask-user" },
        incomingMessageId: assistantMessageId,
        incomingMessageRole: "assistant",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    if (execution === null) {
      throw new Error("Expected the continuation to be claimed");
    }
    const resolvedParts = [
      {
        arguments:
          '{"analysis":"Need jurisdiction","questions":[{"question":"Which court?","reason":"Jurisdiction determines the law."}]}',
        id: "ask-1",
        input: {
          analysis: "Need jurisdiction",
          questions: [
            {
              question: "Which court?",
              reason: "Jurisdiction determines the law.",
            },
          ],
        },
        name: "ask-user",
        output: {
          answers: [{ answer: "Commercial Court", question: "Which court?" }],
        },
        state: "complete",
        type: "tool-call",
      },
    ] satisfies ChatPart[];
    const owningAssistantMessage = toPersistableChatMessage({
      id: assistantMessageId,
      metadata: {
        turnOutcome: {
          interaction: { toolCallId: "ask-1", type: "ask-user" },
          type: "awaiting-user",
        },
      },
      parts: resolvedParts,
      role: "assistant",
    });

    unwrap(
      await persistFailedChatTurn({
        code: "connector-discovery",
        execution,
        owningAssistantMessage,
        recordAuditEvent: async () => {},
        retryable: true,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );

    const messages = await testDb.query.chatMessages.findMany({
      where: { threadId: { eq: threadId } },
      columns: { content: true, id: true, role: true },
    });
    expect(messages).toHaveLength(2);
    const assistant = messages.find(({ id }) => id === assistantMessageId);
    if (assistant === undefined) {
      throw new Error("Expected the owning assistant to remain persisted");
    }
    const reloaded = clientMessageFromPageRow(assistant, new Map());
    expect(reloaded.metadata?.turnOutcome).toEqual({
      error: "unknown",
      type: "failed",
    });
    // v3 persists canonical input rather than the lexical JSON argument
    // string, whose object-key order is not preserved by PostgreSQL JSONB.
    expect(reloaded.parts).toMatchObject([
      {
        id: "ask-1",
        input: {
          analysis: "Need jurisdiction",
          questions: [
            {
              question: "Which court?",
              reason: "Jurisdiction determines the law.",
            },
          ],
        },
        name: "ask-user",
        output: {
          answers: [{ answer: "Commercial Court", question: "Which court?" }],
        },
        state: "complete",
        type: "tool-call",
      },
    ]);
    expect(
      await testDb.query.chatTurns.findFirst({
        where: { id: { eq: acceptance.id } },
        columns: { assistantMessageId: true, status: true },
      }),
    ).toEqual({ assistantMessageId, status: "failed" });
  });

  test("finalizes the assistant message, data scope, and turn atomically", async () => {
    const { assistantMessageId, threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft an NDA", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    if (execution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }

    const result = await finalizeAssistantTurn({
      acceptedSendMode: null,
      dataScopeExpansion: { newWorkspaceIds: [ids.wsA1] },
      existingIds: new Set([userMessageId]),
      execution,
      outcome: { type: "completed" },
      recordAuditEvent: async () => {},
      responseMessage: toPersistableChatMessage({
        id: assistantMessageId,
        parts: [{ content: "Here is the NDA.", type: "text" }],
        role: "assistant",
      }),
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    expect(Result.isOk(result)).toBe(true);
    expect(
      await testDb.query.chatMessages.findFirst({
        where: { id: { eq: assistantMessageId } },
      }),
    ).toMatchObject({ id: assistantMessageId, role: "assistant" });
    expect(
      await testDb.query.chatThreads.findFirst({
        columns: { dataWorkspaceIds: true },
        where: { id: { eq: threadId } },
      }),
    ).toEqual({ dataWorkspaceIds: [ids.wsA1] });
    expect(
      await testDb.query.chatTurns.findFirst({
        where: { id: { eq: execution.id } },
      }),
    ).toMatchObject({
      assistantMessageId,
      executionId: null,
      status: "completed",
    });
  });

  test("rolls back assistant finalization when an atomic write fails", async () => {
    const { assistantMessageId, threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft an NDA", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    if (execution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }
    let auditCalls = 0;

    const result = await finalizeAssistantTurn({
      acceptedSendMode: null,
      dataScopeExpansion: { newWorkspaceIds: [ids.wsA1] },
      existingIds: new Set([userMessageId]),
      execution,
      outcome: { type: "completed" },
      recordAuditEvent: async () => {
        auditCalls += 1;
        if (auditCalls === 2) {
          throw new Error("Injected assistant audit failure");
        }
      },
      responseMessage: toPersistableChatMessage({
        id: assistantMessageId,
        parts: [{ content: "Here is the NDA.", type: "text" }],
        role: "assistant",
      }),
      safeDb,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    expect(Result.isError(result)).toBe(true);
    expect(
      await testDb.query.chatMessages.findFirst({
        where: { id: { eq: assistantMessageId } },
      }),
    ).toBeUndefined();
    expect(
      await testDb.query.chatThreads.findFirst({
        columns: { dataWorkspaceIds: true },
        where: { id: { eq: threadId } },
      }),
    ).toEqual({ dataWorkspaceIds: [] });
    expect(
      await testDb.query.chatTurns.findFirst({
        where: { id: { eq: execution.id } },
      }),
    ).toMatchObject({
      assistantMessageId: null,
      executionId: execution.executionId,
      status: "running",
    });
  });

  test("accepts with the user message and settles once with the assistant message", async () => {
    const { assistantMessageId, threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });

    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft an NDA", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    expect(execution).not.toBeNull();
    if (execution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }

    const settled = unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: { data: [{ text: "NDA", type: "text" }], version: 1 },
          id: assistantMessageId,
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        return await settleChatTurnOnTx({
          assistantMessageId,
          execution,
          outcome: { type: "completed" },
          tx,
        });
      }),
    );
    expect(settled).toBe(true);

    const duplicateSettlement = unwrap(
      await safeDb(
        async (tx) =>
          await settleChatTurnOnTx({
            assistantMessageId,
            execution,
            outcome: { type: "completed" },
            tx,
          }),
      ),
    );
    expect(duplicateSettlement).toBe(false);

    const turn = await testDb.query.chatTurns.findFirst({
      where: { id: { eq: acceptance.id } },
    });
    expect(turn).toMatchObject({
      assistantMessageId,
      executionId: null,
      status: "completed",
      userMessageId,
    });

    const replay = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: null,
        incomingMessageId: userMessageId,
        incomingMessageRole: "user",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    expect(replay).toBeNull();
    expect(
      await testDb.query.chatTurns.findMany({
        where: { userMessageId: { eq: userMessageId } },
      }),
    ).toHaveLength(1);

    const regeneration = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        expect(
          await insertChatTurnAcceptanceOnTx({
            acceptance: regeneration,
            tx,
          }),
        ).toBe(true);
      }),
    );
    const regeneratedExecution = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: regeneration.id,
        incomingMessageId: userMessageId,
        incomingMessageRole: "user",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    expect(regeneratedExecution?.id).toBe(regeneration.id);
    expect(
      await testDb.query.chatTurns.findMany({
        where: { userMessageId: { eq: userMessageId } },
      }),
    ).toHaveLength(2);
  });

  test("adopts a persisted pre-migration user message into the durable lifecycle", async () => {
    const { threadId, userMessageId } = await seedThread();
    await testDb.insert(chatMessages).values({
      content: { data: [{ text: "Draft an NDA", type: "text" }], version: 1 },
      id: userMessageId,
      role: "user",
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    });

    const execution = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: null,
        incomingMessageId: userMessageId,
        incomingMessageRole: "user",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    expect(execution).not.toBeNull();

    const turn = await testDb.query.chatTurns.findFirst({
      where: { userMessageId: { eq: userMessageId } },
    });
    expect(turn).toMatchObject({
      executionId: execution?.executionId,
      status: "running",
      userMessageId,
    });
  });

  test("resumes the same durable turn after an ask-user answer", async () => {
    const { assistantMessageId, threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft a power of attorney", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
      }),
    );
    const initialExecution = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: acceptance.id,
        incomingMessageId: userMessageId,
        incomingMessageRole: "user",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    if (initialExecution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }

    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: awaitingAskUserContent,
          id: assistantMessageId,
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        return await settleChatTurnOnTx({
          assistantMessageId,
          execution: initialExecution,
          outcome: {
            interaction: { toolCallId: "ask-1", type: "ask-user" },
            type: "awaiting-user",
          },
          tx,
        });
      }),
    );

    const resumedExecution = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: null,
        continuationInteraction: { toolCallId: "ask-1", type: "ask-user" },
        incomingMessageId: assistantMessageId,
        incomingMessageRole: "assistant",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    expect(resumedExecution).not.toBeNull();
    expect(resumedExecution?.id).toBe(acceptance.id);

    const turn = await testDb.query.chatTurns.findFirst({
      where: { id: { eq: acceptance.id } },
    });
    expect(turn).toMatchObject({
      assistantMessageId: null,
      interactionToolCallId: null,
      interactionType: null,
      status: "running",
    });
  });

  test("keeps an awaited interaction durable when a continuation names another tool", async () => {
    const { assistantMessageId, threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values([
          {
            content: {
              data: [{ text: "Draft a response", type: "text" }],
              version: 1,
            },
            id: userMessageId,
            role: "user",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          },
          {
            content: {
              data: [{ text: "Which court?", type: "text" }],
              version: 1,
            },
            id: assistantMessageId,
            role: "assistant",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          },
        ]);
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
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
              interaction: { toolCallId: "ask-1", type: "ask-user" },
              type: "awaiting-user",
            },
            tx,
          }),
      ),
    );

    const continuation = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: null,
        continuationInteraction: {
          toolCallId: "forged-approval",
          type: "approval",
        },
        incomingMessageId: assistantMessageId,
        incomingMessageRole: "assistant",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    expect(continuation).toBeNull();
    expect(
      await testDb.query.chatTurns.findFirst({
        where: { id: { eq: acceptance.id } },
        columns: {
          interactionToolCallId: true,
          interactionType: true,
          status: true,
        },
      }),
    ).toEqual({
      interactionToolCallId: "ask-1",
      interactionType: "ask-user",
      status: "awaiting-user",
    });
  });

  test("resumes from every pending approval in one assistant response", async () => {
    const { assistantMessageId, threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    const pendingApprovals = toChatMessageContent({
      data: [
        {
          arguments: '{"name":"First","source":"@title First"}',
          id: "approval-first",
          input: { name: "First", source: "@title First" },
          name: "create-document",
          state: "approval-requested",
          type: "tool-call",
        },
        {
          arguments: '{"name":"Second","source":"@title Second"}',
          id: "approval-second",
          input: { name: "Second", source: "@title Second" },
          name: "create-document",
          state: "approval-requested",
          type: "tool-call",
        },
        {
          arguments:
            '{"analysis":"Need jurisdiction","questions":[{"question":"Which court?","reason":"Jurisdiction determines the law."}]}',
          id: "ask-1",
          input: {
            analysis: "Need jurisdiction",
            questions: [
              {
                question: "Which court?",
                reason: "Jurisdiction determines the law.",
              },
            ],
          },
          name: "ask-user",
          state: "input-complete",
          type: "tool-call",
        },
      ] satisfies ChatPart[],
      version: 2,
    });

    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values([
          {
            content: {
              data: [{ text: "Create both documents", type: "text" }],
              version: 1,
            },
            id: userMessageId,
            role: "user",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          },
          {
            content: pendingApprovals,
            id: assistantMessageId,
            role: "assistant",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          },
        ]);
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
      }),
    );
    const initialExecution = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: acceptance.id,
        incomingMessageId: userMessageId,
        incomingMessageRole: "user",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    if (initialExecution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }
    unwrap(
      await safeDb(
        async (tx) =>
          await settleChatTurnOnTx({
            assistantMessageId,
            execution: initialExecution,
            outcome: {
              interaction: { toolCallId: "approval-first", type: "approval" },
              type: "awaiting-user",
            },
            tx,
          }),
      ),
    );

    const continuation = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: null,
        continuationInteraction: { toolCallId: "ask-1", type: "ask-user" },
        incomingMessageId: assistantMessageId,
        incomingMessageRole: "assistant",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );

    expect(continuation?.id).toBe(acceptance.id);
  });

  test("rejects a competing send before its user message can be persisted", async () => {
    const { threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "First request", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    expect(execution).not.toBeNull();

    const candidateId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const canAccept = unwrap(
      await safeDb(async (tx) => {
        const reserved = await canAcceptChatTurnOnTx({ threadId, tx });
        if (reserved) {
          await tx.insert(chatMessages).values({
            content: {
              data: [{ text: "Competing request", type: "text" }],
              version: 1,
            },
            id: candidateId,
            role: "user",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          });
        }
        return reserved;
      }),
    );
    expect(canAccept).toBe(false);
    expect(
      await testDb.query.chatMessages.findFirst({
        where: { id: { eq: candidateId } },
        columns: { id: true },
      }),
    ).toBeUndefined();
  });

  test("reclaims an expired execution before accepting its replacement", async () => {
    const { threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "First request", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    if (execution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }

    const expiredAt = new Date(Date.now() - 1000);
    await testDb
      .update(chatTurns)
      .set({
        createdAt: new Date(expiredAt.getTime() - 1000),
        leaseExpiresAt: expiredAt,
      })
      .where(eq(chatTurns.id, execution.id));

    const replacementMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const replacement = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId: replacementMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Replacement request", type: "text" }],
            version: 1,
          },
          id: replacementMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(
          await insertChatTurnAcceptanceOnTx({ acceptance: replacement, tx }),
        ).toBe(true);
      }),
    );

    const turns = await testDb.query.chatTurns.findMany({
      where: { threadId: { eq: threadId } },
      columns: {
        executionId: true,
        id: true,
        interruptionReason: true,
        leaseExpiresAt: true,
        settledAt: true,
        status: true,
      },
    });
    expect(turns).toEqual(
      expect.arrayContaining([
        {
          executionId: null,
          id: acceptance.id,
          interruptionReason: "timeout",
          leaseExpiresAt: null,
          settledAt: expect.any(Date),
          status: "interrupted",
        },
        {
          executionId: null,
          id: replacement.id,
          interruptionReason: null,
          leaseExpiresAt: expect.any(Date),
          settledAt: null,
          status: "accepted",
        },
      ]),
    );
    expect(
      unwrap(await renewChatTurnExecutionLease({ execution, safeDb })),
    ).toBe(false);
  });

  test("serializes an awaiting continuation with a competing user send", async () => {
    const { assistantMessageId, threadId } = await seedAwaitingTurn();
    const replacementMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const replacementAcceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId: replacementMessageId,
      workspaceId: ids.wsA1,
    });

    const [continuationResult, replacementResult] = await Promise.all([
      claimChatTurnForExecution({
        acceptedTurnId: null,
        continuationInteraction: { toolCallId: "ask-1", type: "ask-user" },
        incomingMessageId: assistantMessageId,
        incomingMessageRole: "assistant",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
      safeDb(async (tx) => {
        if (!(await canAcceptChatTurnOnTx({ threadId, tx }))) {
          return false;
        }
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "A competing request", type: "text" }],
            version: 1,
          },
          id: replacementMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(
          await insertChatTurnAcceptanceOnTx({
            acceptance: replacementAcceptance,
            tx,
          }),
        ).toBe(true);
        return true;
      }),
    ]);
    const continuation = unwrap(continuationResult);
    const replacementAccepted = unwrap(replacementResult);

    // The two paths share the thread-row lock: exactly one owns the next
    // execution. The losing continuation is a recoverable 409 at the handler.
    expect(continuation === null).toBe(replacementAccepted);
    expect(
      await testDb.query.chatMessages.findFirst({
        where: { id: { eq: replacementMessageId } },
        columns: { id: true },
      }),
    ).toEqual(replacementAccepted ? { id: replacementMessageId } : undefined);
  });

  test("terminalizes a superseded interaction before its replacement reloads", async () => {
    const { acceptance, assistantMessageId, threadId } =
      await seedAwaitingTurn();
    await testDb
      .update(chatMessages)
      .set({ content: awaitingApprovalAndAskUserContent })
      .where(eq(chatMessages.id, assistantMessageId));
    const replacementMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const replacement = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId: replacementMessageId,
      workspaceId: ids.wsA1,
    });

    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "A newer request", type: "text" }],
            version: 1,
          },
          id: replacementMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(
          await insertChatTurnAcceptanceOnTx({ acceptance: replacement, tx }),
        ).toBe(true);
      }),
    );

    const staleAssistant = await testDb.query.chatMessages.findFirst({
      where: { id: { eq: assistantMessageId } },
      columns: { content: true, id: true, role: true },
    });
    if (staleAssistant === undefined) {
      throw new Error("Expected the superseded assistant message to persist");
    }
    const reloadedAssistant = clientMessageFromPageRow(
      staleAssistant,
      new Map(),
    );
    expect(reloadedAssistant.metadata?.turnOutcome).toEqual({
      reason: "superseded",
      type: "cancelled",
    });
    expect(getAwaitingUserInteractions(reloadedAssistant)).toEqual([]);
    expect(
      reloadedAssistant.parts.flatMap((part) =>
        part.type === "tool-call"
          ? [
              {
                approval: Reflect.get(part, "approval"),
                input: Reflect.get(part, "input"),
                state: part.state,
              },
            ]
          : [],
      ),
    ).toEqual([
      {
        approval: {
          approved: false,
          id: "approval-1",
          needsApproval: true,
        },
        input: { query: "Draft" },
        state: "approval-responded",
      },
      { approval: undefined, input: undefined, state: "error" },
    ]);

    const staleContinuation = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: null,
        continuationInteraction: { toolCallId: "ask-1", type: "ask-user" },
        incomingMessageId: assistantMessageId,
        incomingMessageRole: "assistant",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    expect(staleContinuation).toBeNull();
    expect(
      await testDb.query.chatTurns.findFirst({
        where: { id: { eq: acceptance.id } },
        columns: { cancellationReason: true, status: true },
      }),
    ).toEqual({ cancellationReason: "superseded", status: "cancelled" });
  });

  test("a duplicate awaiting-user claim cannot mutate replay history", async () => {
    const { assistantMessageId, threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft a response", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
      }),
    );
    const initialExecution = unwrap(
      await claimChatTurnForExecution({
        acceptedTurnId: acceptance.id,
        incomingMessageId: userMessageId,
        incomingMessageRole: "user",
        organizationId: ids.orgA,
        safeDb,
        threadId,
        userId: ids.userA1,
        workspaceId: ids.wsA1,
      }),
    );
    if (initialExecution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: awaitingAskUserContent,
          id: assistantMessageId,
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        return await settleChatTurnOnTx({
          assistantMessageId,
          execution: initialExecution,
          outcome: {
            interaction: { toolCallId: "ask-1", type: "ask-user" },
            type: "awaiting-user",
          },
          tx,
        });
      }),
    );

    const claim = {
      acceptedTurnId: null,
      continuationInteraction: { toolCallId: "ask-1", type: "ask-user" },
      incomingMessageId: assistantMessageId,
      incomingMessageRole: "assistant" as const,
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    } as const satisfies ChatTurnExecutionClaim;
    const winner = unwrap(
      await withClaimedChatTurnExecution({
        claim,
        safeDb,
        mutate: async ({ tx }) => {
          await tx
            .update(chatMessages)
            .set({
              content: {
                data: [{ text: "Winner response", type: "text" }],
                version: 1,
              },
            })
            .where(inArray(chatMessages.id, [assistantMessageId]));
        },
      }),
    );
    expect(winner).not.toBeNull();

    let duplicateMutationRan = false;
    const duplicate = unwrap(
      await withClaimedChatTurnExecution({
        claim,
        safeDb,
        mutate: async ({ tx }) => {
          duplicateMutationRan = true;
          await tx
            .update(chatMessages)
            .set({
              content: {
                data: [{ text: "Duplicate response", type: "text" }],
                version: 1,
              },
            })
            .where(inArray(chatMessages.id, [assistantMessageId]));
        },
      }),
    );
    expect(duplicate).toBeNull();
    expect(duplicateMutationRan).toBe(false);

    const message = await testDb.query.chatMessages.findFirst({
      where: { id: { eq: assistantMessageId } },
      columns: { content: true },
    });
    expect(message?.content).toEqual({
      data: [{ text: "Winner response", type: "text" }],
      version: 1,
    });
  });

  test("renews a claimed execution past the full provider timeout", async () => {
    const { threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft an NDA", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    if (execution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }

    const beforeRenewal = Date.now();
    expect(
      unwrap(await renewChatTurnExecutionLease({ execution, safeDb })),
    ).toBe(true);

    const turn = await testDb.query.chatTurns.findFirst({
      where: { id: { eq: execution.id } },
      columns: { leaseExpiresAt: true },
    });
    expect(turn?.leaseExpiresAt?.getTime()).toBeGreaterThanOrEqual(
      beforeRenewal + CHAT_METERED_PROVIDER_TIMEOUT_MS,
    );
  });

  test("terminalizes a claimed turn when work fails before streaming", async () => {
    const { threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft an NDA", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    if (execution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }

    const failedAssistantMessageId = toSafeId<"chatMessage">(
      Bun.randomUUIDv7(),
    );
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: toChatMessageContent({
            data: [],
            metadata: { turnOutcome: { error: "unknown", type: "failed" } },
            version: 2,
          }),
          id: failedAssistantMessageId,
          role: "assistant",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        return await settleChatTurnOnTx({
          assistantMessageId: failedAssistantMessageId,
          execution,
          failureCode: "unsupported-input",
          failureRetryable: false,
          outcome: { error: "unknown", type: "failed" },
          tx,
        });
      }),
    );
    const turn = await testDb.query.chatTurns.findFirst({
      where: { id: { eq: execution.id } },
    });
    expect(turn).toMatchObject({
      assistantMessageId: failedAssistantMessageId,
      executionId: null,
      failureCode: "unsupported-input",
      failureRetryable: false,
      leaseExpiresAt: null,
      status: "failed",
    });
    const failedAssistant = await testDb.query.chatMessages.findFirst({
      where: { id: { eq: failedAssistantMessageId } },
      columns: { content: true, id: true, role: true },
    });
    if (failedAssistant === undefined) {
      throw new Error("Expected the failed assistant message to persist");
    }
    expect(
      clientMessageFromPageRow(failedAssistant, new Map()).metadata
        ?.turnOutcome,
    ).toEqual({ error: "unknown", type: "failed" });
  });

  test("settles through the database clock when the worker clock is behind", async () => {
    const { threadId, userMessageId } = await seedThread();
    const acceptance = createChatTurnAcceptance({
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      userMessageId,
      workspaceId: ids.wsA1,
    });
    unwrap(
      await safeDb(async (tx) => {
        await tx.insert(chatMessages).values({
          content: {
            data: [{ text: "Draft an NDA", type: "text" }],
            version: 1,
          },
          id: userMessageId,
          role: "user",
          threadId,
          userId: ids.userA1,
          workspaceId: ids.wsA1,
        });
        expect(await insertChatTurnAcceptanceOnTx({ acceptance, tx })).toBe(
          true,
        );
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
        workspaceId: ids.wsA1,
      }),
    );
    if (execution === null) {
      throw new Error("Expected the accepted turn to be claimed");
    }

    const originalDate = globalThis.Date;
    const workerClockEpoch = new originalDate("2000-01-01T00:00:00.000Z");
    class WorkerClockBehindDatabase extends originalDate {
      constructor(value?: string | number | Date) {
        super(value ?? workerClockEpoch);
      }

      // Keep the embedded database's monotonic clock real while making an
      // API-side `new Date()` visibly stale.
      static override now = () => originalDate.now();
    }
    Object.defineProperty(globalThis, "Date", {
      configurable: true,
      value: WorkerClockBehindDatabase,
    });
    try {
      const failedAssistantMessageId = toSafeId<"chatMessage">(
        Bun.randomUUIDv7(),
      );
      unwrap(
        await safeDb(async (tx) => {
          await tx.insert(chatMessages).values({
            content: toChatMessageContent({
              data: [],
              metadata: {
                turnOutcome: { error: "unknown", type: "failed" },
              },
              version: 2,
            }),
            id: failedAssistantMessageId,
            role: "assistant",
            threadId,
            userId: ids.userA1,
            workspaceId: ids.wsA1,
          });
          return await settleChatTurnOnTx({
            assistantMessageId: failedAssistantMessageId,
            execution,
            failureCode: "unsupported-input",
            failureRetryable: false,
            outcome: { error: "unknown", type: "failed" },
            tx,
          });
        }),
      );
    } finally {
      Object.defineProperty(globalThis, "Date", {
        configurable: true,
        value: originalDate,
      });
    }

    const turn = await testDb.query.chatTurns.findFirst({
      where: { id: { eq: execution.id } },
      columns: { settledAt: true, status: true },
    });
    expect(turn).toMatchObject({ status: "failed" });
    expect(turn?.settledAt).not.toBeNull();
  });
});
