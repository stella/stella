import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

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
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { sweepChatCommandReceipts } from "@/api/lib/scheduler/tasks/chat-command-receipt-retention";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import {
  APPROVAL_TOOL_NAME,
  approvalToolArguments,
  createApprovalHarness,
  pendingApprovalCallOf,
} from "@/api/tests/helpers/chat-approval-harness";
import type { ChatHarness } from "@/api/tests/helpers/chat-approval-harness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
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
  // Classifies database failures as a request's handle does: the losing
  // first send of a new thread recovers from the thread's key conflict.
  safeDb = createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1);
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

  test("racing its first attempt on a new thread, exactly one runs and the other is answered with its turn", async () => {
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
      expect(await messagesOf(threadId)).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  test("racing its first attempt, which takes the turn between its read and its claim, is answered with that turn", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    const commandId = Bun.randomUUIDv7();
    const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
    try {
      // The thread exists: a retry follows its first attempt by a while.
      harness.script(threadId, [
        { finishReason: "stop", text: "Hello.", type: "text" },
      ]);
      const opening = commandSend({
        commandId: Bun.randomUUIDv7(),
        harness,
        messageId: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
        threadId,
      });
      expect(await harness.send(opening)).toEqual({ status: "streamed" });

      let raceRan = false;
      harness.raceNextAcceptance(async () => {
        harness.script(threadId, [
          { finishReason: "stop", text: "It runs for a year.", type: "text" },
        ]);
        expect(
          await harness.send(
            commandSend({ commandId, harness, messageId, threadId }),
          ),
        ).toEqual({ status: "streamed" });
        raceRan = true;
      });
      const retry = commandSend({ commandId, harness, messageId, threadId });
      const outcome = await harness.send(retry);

      // The fixture must reach the race: the first attempt won in between.
      expect(raceRan).toBe(true);
      expect(outcome).toEqual(replayed);
      const receipt = (await receiptOf(commandId)).at(0);
      expect(retry.set.headers[CHAT_TURN_ID_HEADER]).toBe(
        receipt?.turnId ?? "",
      );
      expect(await turnsOf(threadId)).toHaveLength(2);
      expect(await messagesOf(threadId)).toHaveLength(4);
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

describe("an answer retried under its command id", () => {
  test("is answered with the turn it continued and runs the approved tool once", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const threadId = newThreadId();
    const commandId = Bun.randomUUIDv7();
    const runId = `run-${Bun.randomUUIDv7()}`;
    try {
      harness.script(threadId, [
        {
          arguments: approvalToolArguments("NDA"),
          toolCallId: "call-NDA",
          toolName: APPROVAL_TOOL_NAME,
          type: "tool-call",
        },
      ]);
      expect(
        await harness.send(
          harness.sendContext({
            message: {
              id: toSafeId<"chatMessage">(Bun.randomUUIDv7()),
              parts: [{ content: "Delete the NDA", type: "text" }],
              role: "user",
            },
            runId,
            threadId,
          }),
        ),
      ).toEqual({ status: "streamed" });
      const awaitingTurnId =
        (await turnsOf(threadId)).at(0)?.id ?? panic("The send stored no turn");
      const pending = await harness.lastAssistant(threadId);
      const call = pendingApprovalCallOf(pending.parts);
      /** The member's approval as their client sends it, under one id. */
      const approval = () => {
        const ctx = harness.approveContext({
          call,
          interruptedRunId: runId,
          messageId: pending.id,
          parts: pending.parts,
          threadId,
        });
        Object.assign(ctx.headers, { [CHAT_COMMAND_ID_HEADER]: commandId });
        return ctx;
      };

      harness.script(threadId, [
        { finishReason: "stop", text: "The NDA is deleted.", type: "text" },
      ]);
      expect(await harness.send(approval())).toEqual({ status: "streamed" });
      expect(harness.executions).toEqual(["NDA"]);
      expect(await receiptOf(commandId)).toEqual([
        { commandType: "answer", threadId, turnId: awaitingTurnId },
      ]);
      const turnsAnswered = await turnsOf(threadId);

      const retry = approval();
      expect(await harness.send(retry)).toEqual(replayed);
      expect(retry.set.headers[CHAT_TURN_ID_HEADER]).toBe(awaitingTurnId);
      // The tool ran once and the thread holds no other turn.
      expect(harness.executions).toEqual(["NDA"]);
      expect(await turnsOf(threadId)).toEqual(turnsAnswered);
    } finally {
      await harness.close();
    }
  });
});

describe("the receipt sweep", () => {
  test("deletes receipts older than a day and keeps newer ones", async () => {
    const harness = createApprovalHarness({ ids, safeDb, scopedDb, testDb });
    const expiredId = Bun.randomUUIDv7();
    const keptId = Bun.randomUUIDv7();
    try {
      for (const commandId of [expiredId, keptId]) {
        const threadId = newThreadId();
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
      }
      // The sweep runs a day and an hour after the expired receipt was
      // accepted, and an hour after the kept one.
      const acceptedAt = (commandId: string, at: string) =>
        testDb
          .update(chatCommandReceipts)
          .set({ acceptedAt: sql`${at}::timestamptz` })
          .where(eq(chatCommandReceipts.commandId, commandId));
      await acceptedAt(expiredId, "2026-01-01T00:00:00Z");
      await acceptedAt(keptId, "2026-01-02T00:00:00Z");

      await sweepChatCommandReceipts(
        asTestRaw<SchedulerTaskContext>({
          db: testDb,
          dueAt: DueSlot.of({ nextRunAt: new Date("2026-01-02T01:00:00Z") }),
          logger: { info: () => undefined },
          signal: new AbortController().signal,
        }),
      );

      expect(await receiptOf(expiredId)).toEqual([]);
      expect(await receiptOf(keptId)).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
