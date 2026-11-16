import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import {
  CHAT_COMMAND_ERROR_CODE,
  CHAT_COMMAND_ID_HEADER,
} from "@stll/api-contract/chat-command";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  chatCommandReceipts,
  chatMessages,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
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

// A client resends a send whose response it lost, under the command id it
// minted for it. The retry must be answered with the turn the first attempt
// started, never start another one, whichever arrives first.

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

/** A member's send as their client sends it, under a command id. */
const commandSend = ({
  commandId,
  harness,
  messageId,
  threadId,
}: {
  commandId: string;
  harness: ChatHarness;
  messageId: SafeId<"chatMessage">;
  threadId: SafeId<"chatThread">;
}) => {
  const ctx = harness.sendContext({
    message: {
      id: messageId,
      parts: [{ content: "What does the lease say?", type: "text" }],
      role: "user",
    },
    runId: `run-${Bun.randomUUIDv7()}`,
    threadId,
  });
  Object.assign(ctx.headers, { [CHAT_COMMAND_ID_HEADER]: commandId });
  return ctx;
};

const turnsOf = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(eq(chatTurns.threadId, threadId));

const messagesOf = async (threadId: SafeId<"chatThread">) =>
  await testDb
    .select({ id: chatMessages.id, role: chatMessages.role })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId));

const receiptOf = async (commandId: string) =>
  await testDb
    .select({
      commandType: chatCommandReceipts.commandType,
      threadId: chatCommandReceipts.threadId,
      turnId: chatCommandReceipts.turnId,
    })
    .from(chatCommandReceipts)
    .where(eq(chatCommandReceipts.commandId, commandId));

const replayed = {
  rejection: {
    code: 409,
    response: {
      code: CHAT_COMMAND_ERROR_CODE.replayed,
      message: "The command was accepted earlier; join its turn",
    },
  },
  status: "rejected",
} as const;

describe("a send retried under its command id", () => {
  test("is answered with the first attempt's turn and starts no other", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    const commandId = Bun.randomUUIDv7();
    const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    try {
      harness.script(threadId, [
        { finishReason: "stop", text: "It runs for a year.", type: "text" },
      ]);
      const first = commandSend({ commandId, harness, messageId, threadId });
      expect(await harness.send(first)).toEqual({ status: "streamed" });
      const turnId =
        (await turnsOf(threadId)).at(0)?.id ?? panic("The send stored no turn");
      expect(await receiptOf(commandId)).toEqual([
        { commandType: "send", threadId, turnId },
      ]);

      const retry = commandSend({ commandId, harness, messageId, threadId });
      expect(await harness.send(retry)).toEqual(replayed);
      expect(retry.set.headers[CHAT_TURN_ID_HEADER]).toBe(turnId);
      expect(await turnsOf(threadId)).toHaveLength(1);
      expect(await messagesOf(threadId)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  test("racing its first attempt, exactly one runs and the other is answered with its turn", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    const commandId = Bun.randomUUIDv7();
    const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    try {
      harness.script(threadId, [
        { finishReason: "stop", text: "It runs for a year.", type: "text" },
      ]);
      const attempts = [
        commandSend({ commandId, harness, messageId, threadId }),
        commandSend({ commandId, harness, messageId, threadId }),
      ];
      const outcomes = await Promise.all(
        attempts.map(async (ctx) => await harness.send(ctx)),
      );
      expect(outcomes).toContainEqual({ status: "streamed" });
      expect(outcomes).toContainEqual(replayed);
      const turns = await turnsOf(threadId);
      expect(turns).toHaveLength(1);
      for (const ctx of attempts) {
        expect(ctx.set.headers[CHAT_TURN_ID_HEADER]).toBe(turns[0]?.id);
      }
    } finally {
      await harness.close();
    }
  });

  test("under an id another thread's receipt holds is refused and changes nothing", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    const otherThreadId = newThreadId();
    const commandId = Bun.randomUUIDv7();
    try {
      harness.script(threadId, [
        { finishReason: "stop", text: "It runs for a year.", type: "text" },
      ]);
      expect(
        await harness.send(
          commandSend({
            commandId,
            harness,
            messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
            threadId,
          }),
        ),
      ).toEqual({ status: "streamed" });

      const reused = commandSend({
        commandId,
        harness,
        messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        threadId: otherThreadId,
      });
      const outcome = await harness.send(reused);
      expect(outcome).toMatchObject({
        rejection: {
          code: 409,
          response: { code: CHAT_COMMAND_ERROR_CODE.conflict },
        },
        status: "rejected",
      });
      expect(reused.set.headers[CHAT_TURN_ID_HEADER]).toBeUndefined();
      expect(await messagesOf(otherThreadId)).toEqual([]);
      expect(await turnsOf(otherThreadId)).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  test("a send without a command id leaves no receipt", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    try {
      harness.script(threadId, [
        { finishReason: "stop", text: "It runs for a year.", type: "text" },
      ]);
      const ctx = commandSend({
        commandId: Bun.randomUUIDv7(),
        harness,
        messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        threadId,
      });
      Reflect.deleteProperty(ctx.headers, CHAT_COMMAND_ID_HEADER);
      expect(await harness.send(ctx)).toEqual({ status: "streamed" });
      expect(
        await testDb
          .select({ id: chatCommandReceipts.commandId })
          .from(chatCommandReceipts)
          .where(eq(chatCommandReceipts.threadId, threadId)),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
