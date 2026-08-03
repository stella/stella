import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  CHAT_METERED_PROVIDER_TIMEOUT_MS,
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  failChatTurnExecution,
  insertChatTurnAcceptanceOnTx,
  renewChatTurnExecutionLease,
  settleChatTurnOnTx,
  withClaimedChatTurnExecution,
} from "@/api/handlers/chat/chat-turn-persistence";
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

describe("durable chat turn persistence", () => {
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
        await insertChatTurnAcceptanceOnTx({ acceptance, tx });
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
        await insertChatTurnAcceptanceOnTx({ acceptance, tx });
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
          content: {
            data: [{ text: "What scope should it cover?", type: "text" }],
            version: 1,
          },
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
        await insertChatTurnAcceptanceOnTx({ acceptance, tx });
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
          content: {
            data: [{ text: "Which court?", type: "text" }],
            version: 1,
          },
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
      incomingMessageId: assistantMessageId,
      incomingMessageRole: "assistant" as const,
      organizationId: ids.orgA,
      threadId,
      userId: ids.userA1,
      workspaceId: ids.wsA1,
    };
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
        await insertChatTurnAcceptanceOnTx({ acceptance, tx });
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
        await insertChatTurnAcceptanceOnTx({ acceptance, tx });
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

    expect(
      unwrap(
        await failChatTurnExecution({
          code: "unsupported-input",
          execution,
          retryable: false,
          safeDb,
        }),
      ),
    ).toBe(true);
    const turn = await testDb.query.chatTurns.findFirst({
      where: { id: { eq: execution.id } },
    });
    expect(turn).toMatchObject({
      executionId: null,
      failureCode: "unsupported-input",
      failureRetryable: false,
      leaseExpiresAt: null,
      status: "failed",
    });
  });
});
