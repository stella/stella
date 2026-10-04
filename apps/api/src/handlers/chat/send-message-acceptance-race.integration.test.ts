import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  toChatMessageContent,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { persistAcceptedMessageWithClaim } from "@/api/handlers/chat/chat-message-persistence";
import { createChatTurnAcceptance } from "@/api/handlers/chat/chat-turn-persistence";
import { resolveTruncationTarget } from "@/api/handlers/chat/history-window";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createApprovalHarness } from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// A send plans its turn on the history it read: the model's context, and for a
// replay the rows it deletes. Another turn can run to its end between that
// read and the send's claim. The claim must then refuse the stale plan rather
// than answer without the turn that won, or delete and replay around it.

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

const newThreadId = (): SafeId<"chatThread"> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  seededThreadIds.push(threadId);
  return threadId;
};

const storedThread = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({ id: chatMessages.id, role: chatMessages.role })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

const turnsOf = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({
      status: chatTurns.status,
      userMessageId: chatTurns.userMessageId,
    })
    .from(chatTurns)
    .where(eq(chatTurns.threadId, threadId));

const sendText = ({
  harness,
  messageId,
  text,
  threadId,
}: {
  harness: ChatHarness;
  messageId: SafeId<"chatMessage">;
  text: string;
  threadId: SafeId<"chatThread">;
}) =>
  harness.sendContext({
    message: {
      id: messageId,
      parts: [{ content: text, type: "text" }],
      role: "user",
    },
    runId: `run-${Bun.randomUUIDv7()}`,
    threadId,
  });

describe("a send whose thread changed between its read and its claim", () => {
  test("is refused, and its retry answers after the turn that won", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    try {
      harness.script(threadId, [
        { finishReason: "stop", text: "First answer.", type: "text" },
      ]);
      expect(
        await harness.send(
          sendText({
            harness,
            messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
            text: "First question",
            threadId,
          }),
        ),
      ).toEqual({ status: "streamed" });

      const winningMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
      const racedMessageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
      let raceRan = false;
      harness.raceNextAcceptance(async () => {
        harness.script(threadId, [
          { finishReason: "stop", text: "Winning answer.", type: "text" },
        ]);
        expect(
          await harness.send(
            sendText({
              harness,
              messageId: winningMessageId,
              text: "Winning question",
              threadId,
            }),
          ),
        ).toEqual({ status: "streamed" });
        raceRan = true;
      });
      const refused = await harness.send(
        sendText({
          harness,
          messageId: racedMessageId,
          text: "Raced question",
          threadId,
        }),
      );

      // The fixture must reach the fault: the other turn settled in between.
      expect(raceRan).toBe(true);
      expect(refused).toEqual({
        rejection: {
          code: 409,
          response: {
            message:
              "The chat changed while this message was being sent; send it again",
          },
        },
        status: "rejected",
      });
      const afterRefusal = await storedThread(threadId);
      expect(afterRefusal.map(({ role }) => role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(afterRefusal.map(({ id }) => id)).not.toContain(racedMessageId);
      expect(
        (await turnsOf(threadId)).map(({ userMessageId }) => userMessageId),
      ).not.toContain(racedMessageId);

      harness.script(threadId, [
        { finishReason: "stop", text: "Raced answer.", type: "text" },
      ]);
      expect(
        await harness.send(
          sendText({
            harness,
            messageId: racedMessageId,
            text: "Raced question",
            threadId,
          }),
        ),
      ).toEqual({ status: "streamed" });

      // The accepted retry hands the model the thread as it is now.
      const prompt = harness.promptsOf(threadId).at(-1) ?? [];
      const position = (text: string) =>
        prompt.findIndex((message) => message.includes(text));
      expect(position("Winning question")).toBeGreaterThan(-1);
      expect(position("Winning answer.")).toBeGreaterThan(
        position("Winning question"),
      );
      expect(position("Raced question")).toBeGreaterThan(
        position("Winning answer."),
      );
      expect((await storedThread(threadId)).map(({ role }) => role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    } finally {
      await harness.close();
    }
  });
});

describe("a regeneration of the latest user turn", () => {
  test.each([
    ["no turn settles in between", false],
    ["a newer turn settles in between", true],
  ] as const)("claims its plan when %s", async (_name, raced) => {
    const threadId = newThreadId();
    await testDb.insert(chatThreads).values({
      id: threadId,
      organizationId: ids.orgA,
      title: "Acceptance race test",
      userId: ids.userA1,
      workspaceId: null,
    });
    const messageId = () => toSafeId<"chatMessage">(Bun.randomUUIDv7());
    const regenerated = messageId();
    const staleAnswer = messageId();
    const newerQuestion = messageId();
    const newerAnswer = messageId();
    const insertMessage = async ({
      id,
      offset,
      role,
    }: {
      id: SafeId<"chatMessage">;
      offset: number;
      role: "assistant" | "user";
    }) => {
      await testDb.insert(chatMessages).values({
        content: toChatMessageContent({
          data: [{ content: `message ${offset}`, type: "text" }],
          version: 2,
        }),
        createdAt: new Date(Date.parse("2026-08-03T12:00:00.000Z") + offset),
        id,
        role,
        threadId,
        userId: ids.userA1,
        workspaceId: null,
      });
    };
    await insertMessage({ id: regenerated, offset: 0, role: "user" });
    await insertMessage({ id: staleAnswer, offset: 1, role: "assistant" });

    // The regeneration's read: its target is the latest user turn.
    const target = await resolveTruncationTarget({
      safeDb,
      targetMessageId: regenerated,
      threadId,
    });
    if (Result.isError(target) || target.value === null) {
      throw new Error("seed precondition failed: the target resolves");
    }
    expect(target.value.hasLaterUserMessage).toBe(false);
    expect(target.value.deleteMessageIdsBeforeLatest).toEqual([staleAnswer]);

    if (raced) {
      await insertMessage({ id: newerQuestion, offset: 2, role: "user" });
      await insertMessage({ id: newerAnswer, offset: 3, role: "assistant" });
    }

    const accepted = await persistAcceptedMessageWithClaim({
      deleteMessageIds: target.value.deleteMessageIdsBeforeLatest,
      indexThread: async () => await Promise.resolve(undefined),
      persistencePlan: {
        message: toPersistableChatMessage({
          id: regenerated,
          parts: [{ content: "message 0", type: "text" }],
          role: "user",
        }),
        messageId: regenerated,
        type: "update",
      },
      plannedOnHistory: target.value.snapshot,
      recordAuditEvent: async () => await Promise.resolve(),
      safeDb,
      threadId,
      turnAcceptance: createChatTurnAcceptance({
        organizationId: ids.orgA,
        threadId,
        userId: ids.userA1,
        userMessageId: regenerated,
        workspaceId: null,
      }),
      userId: ids.userA1,
      workspaceId: null,
    });

    expect({
      refusal: Result.isError(accepted) ? accepted.error.message : null,
      stored: (await storedThread(threadId)).map(({ id }) => id),
      turns: await turnsOf(threadId),
    }).toEqual(
      raced
        ? {
            refusal:
              "The chat changed while this message was being sent; send it again",
            stored: [regenerated, staleAnswer, newerQuestion, newerAnswer],
            turns: [],
          }
        : {
            refusal: null,
            stored: [regenerated],
            turns: [{ status: "running", userMessageId: regenerated }],
          },
    );
  });
});
