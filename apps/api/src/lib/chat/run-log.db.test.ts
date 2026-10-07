import {
  EventType,
  toServerSentEventsResponse,
  type StreamChunk,
} from "@tanstack/ai";
import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  chatMessages,
  chatRunLogEntries,
  chatRunLogs,
  chatThreads,
  chatTurns,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  claimChatTurnForExecution,
  createChatTurnAcceptance,
  insertChatTurnAcceptanceOnTx,
  reapOwnerlessChatTurnOnTx,
  settleChatTurnOnTx,
  startChatTurnRun,
  USER_STOP_OUTCOME,
} from "@/api/handlers/chat/chat-turn-persistence";
import type { ChatTurnExecution } from "@/api/handlers/chat/chat-turn-persistence";
import { probeChatTurn } from "@/api/handlers/chat/turns/resume";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createChatRunLog,
  createChatRunLogReplay,
  sweepClosedChatRunLogs,
} from "@/api/lib/chat/run-log";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
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
const seededThreads: SafeId<"chatThread">[] = [];
let rawDb: Pick<typeof rootDb, "transaction">;
let scopedDbA: ScopedDb;
let scopedDbB: ScopedDb;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  rawDb = asTestRaw<Pick<typeof rootDb, "transaction">>(testDb);
  scopedDbA = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
  );
  scopedDbB = asTestRaw<ScopedDb>(
    createScopedDb(testDb, [ids.wsB1], ids.orgB, ids.userB1),
  );
});

afterAll(async () => {
  if (seededThreads.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreads));
  }
  await releaseRlsFixture();
});

const seedRunningTurn = async (): Promise<{
  execution: ChatTurnExecution;
  runId: string;
  threadId: SafeId<"chatThread">;
}> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  const messageId = toSafeId<"chatMessage">(Bun.randomUUIDv7());
  seededThreads.push(threadId);
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    title: "Chat run log test",
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  await testDb.insert(chatMessages).values({
    id: messageId,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
    role: "user",
    content: { data: [{ text: "Run", type: "text" }], version: 1 },
  });
  const acceptance = createChatTurnAcceptance({
    organizationId: ids.orgA,
    threadId,
    userId: ids.userA1,
    userMessageId: messageId,
    workspaceId: ids.wsA1,
  });
  const scopedDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
  const inserted = await scopedDb(
    async (tx) => await insertChatTurnAcceptanceOnTx({ acceptance, tx }),
  );
  if (Result.isError(inserted)) {
    panic("Could not seed chat turn", inserted.error);
  }
  const claimed = await claimChatTurnForExecution({
    acceptedTurnId: acceptance.id,
    incomingMessageId: messageId,
    incomingMessageRole: "user",
    organizationId: ids.orgA,
    safeDb: scopedDb,
    threadId,
    userId: ids.userA1,
    workspaceId: ids.wsA1,
  });
  if (Result.isError(claimed)) {
    panic("Could not claim seeded chat turn", claimed.error);
  }
  const execution =
    claimed.value ?? panic("Expected seeded turn to be claimed");
  const runId = Bun.randomUUIDv7();
  const started = await startChatTurnRun({
    execution,
    runId,
    safeDb: scopedDb,
  });
  if (Result.isError(started)) {
    panic("Could not start seeded chat run", started.error);
  }
  expect(started.value).toBe("owned");
  return { execution, runId, threadId };
};

const logFor = (
  { execution, runId }: { execution: ChatTurnExecution; runId: string },
  db: ScopedDb = scopedDbA,
  organizationId = ids.orgA,
) => createChatRunLog({ db, execution, organizationId, runId });

const chunk = (text: string): StreamChunk => ({
  type: EventType.CUSTOM,
  name: "test",
  value: { text },
});

// bun-types declares `.rejects.toThrow` as void; capture the rejection so
// type-aware lint and the runtime observe the same promise.
const rejectionMessage = async (
  promise: Promise<unknown>,
): Promise<string | null> =>
  await promise.then(
    () => null,
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );

describe("chat run log database contract", () => {
  test("appends in order, preserves JSONB objects, normalizes bigint offsets, and reads strictly after an offset", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const first = {
      type: EventType.CUSTOM,
      name: "test",
      value: { ordinal: 1, flags: [true, null], nested: { enabled: true } },
    } satisfies StreamChunk;
    const second = chunk("two");
    expect(await log.append([first, second])).toEqual(["1", "2"]);
    await log.close();
    const snapshot = await log.snapshot();
    expect(snapshot.map(({ offset }) => offset)).toEqual(["1", "2"]);
    expect(snapshot.map(({ chunk: value }) => value)).toEqual([first, second]);
    const resumed = await Array.fromAsync(
      log.read("1", new AbortController().signal),
    );
    expect(resumed).toEqual([{ offset: "2", chunk: second }]);
  });

  test("rejects an append after the execution fence is lost", async () => {
    const run = await seedRunningTurn();
    const log = logFor({
      ...run,
      execution: { ...run.execution, executionId: Bun.randomUUIDv7() },
    });
    expect(await rejectionMessage(log.append([chunk("rejected")]))).toContain(
      "execution fence lost",
    );
  });

  test("closes idempotently and rejects subsequent appends", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.close();
    await log.close();
    expect(await rejectionMessage(log.append([chunk("late")]))).toContain(
      "closed",
    );
  });

  test("rejects a stale execution close and leaves the open log unchanged", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([chunk("still open")]);
    const stale = logFor({
      ...run,
      execution: { ...run.execution, executionId: Bun.randomUUIDv7() },
    });
    expect(await rejectionMessage(stale.close())).toContain(
      "execution fence lost",
    );
    const [row] = await testDb
      .select({ closedAt: chatRunLogs.closedAt })
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, run.runId));
    expect(row?.closedAt).toBeNull();
    await log.close();
  });

  test("a reader drains stored chunks and waits for the close marker", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const reader = log.read("-1")[Symbol.asyncIterator]();
    const firstRead = reader.next();
    const finished = chunk("live entry");
    await log.append([finished]);
    expect(await firstRead).toEqual({
      done: false,
      value: { offset: "1", chunk: finished },
    });
    const finalRead = reader.next();
    let readerEnded = false;
    void finalRead.then(() => {
      readerEnded = true;
      return undefined;
    });
    await Bun.sleep(20);
    expect(readerEnded).toBe(false);
    await log.close();
    expect(await finalRead).toEqual({ done: true, value: undefined });
  });

  test("keeps repeated chunks at distinct offsets", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const repeated = chunk("same");
    expect(await log.append([repeated, repeated])).toEqual(["1", "2"]);
    await log.close();
    expect(await log.snapshot()).toEqual([
      { offset: "1", chunk: repeated },
      { offset: "2", chunk: repeated },
    ]);
  });

  test("uses forced row security and cascades turn deletion to run log rows", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([chunk("transient")]);
    await log.close();
    const policies = await testDb.execute(sql`
      select relname, relforcerowsecurity
      from pg_class
      where oid in ('public.chat_run_logs'::regclass, 'public.chat_run_log_entries'::regclass)
    `);
    expect(policies.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relname: "chat_run_logs",
          relforcerowsecurity: true,
        }),
        expect.objectContaining({
          relname: "chat_run_log_entries",
          relforcerowsecurity: true,
        }),
      ]),
    );
    await testDb.delete(chatTurns).where(eq(chatTurns.id, run.execution.id));
    const headers = await testDb
      .select()
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, run.runId));
    const entries = await testDb
      .select()
      .from(chatRunLogEntries)
      .where(eq(chatRunLogEntries.runId, run.runId));
    expect(headers).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("scopes reads, appends, and closes to the handle organization", async () => {
    const run = await seedRunningTurn();
    const own = logFor(run);
    await own.append([chunk("tenant A")]);
    // The caller supplies the target organization; the scoped handle still denies it.
    const foreign = logFor(run, scopedDbB, ids.orgA);
    expect(await foreign.snapshot()).toEqual([]);
    expect(
      await rejectionMessage(foreign.append([chunk("wrong tenant")])),
    ).toContain("execution fence lost");
    expect(await rejectionMessage(foreign.close())).toContain(
      "execution fence lost",
    );
    await own.close();
  });

  test("durable delivery stores the final batch before settlement removes its execution fence", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const chunks = [chunk("first"), chunk("second"), chunk("third")];
    const response = toServerSentEventsResponse(
      (async function* () {
        yield* chunks;
      })(),
      {
        durability: {
          adapter: {
            ...log,
            close: async () => {
              await log.close();
              await scopedDbA(
                async (tx) =>
                  await settleChatTurnOnTx({
                    assistantMessageId: null,
                    execution: run.execution,
                    outcome: USER_STOP_OUTCOME,
                    tx,
                  }),
              );
            },
          },
        },
      },
    );
    const delivered = await response.text();
    for (const entry of chunks) {
      expect(delivered).toContain(JSON.stringify(entry));
    }
    expect(
      (await log.snapshot()).slice(1).map(({ chunk: entry }) => entry),
    ).toEqual(chunks);
    const [header] = await testDb
      .select({ closedAt: chatRunLogs.closedAt })
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, run.runId));
    expect(header?.closedAt).toBeInstanceOf(Date);
  });

  test("a final replay event waits for the transaction that stores the turn outcome", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const terminal = {
      type: EventType.RUN_FINISHED,
      threadId: run.threadId,
      runId: run.runId,
    } satisfies StreamChunk;
    await log.append([chunk("prefix"), terminal]);
    const reader = log.read("1")[Symbol.asyncIterator]();
    const received: { value: unknown } = { value: null };
    const pending = reader.next().then((next) => {
      received.value = next;
      return next;
    });
    await Bun.sleep(50);
    expect(received.value).toBeNull();
    await scopedDbA(
      async (tx) =>
        await settleChatTurnOnTx({
          assistantMessageId: null,
          execution: run.execution,
          outcome: USER_STOP_OUTCOME,
          tx,
        }),
    );
    expect(await pending).toEqual({
      done: false,
      value: { offset: "2", chunk: terminal },
    });
    await reader.return?.();
  });

  test("resume route reveals a run only to its owning user, thread and organization", async () => {
    const run = await seedRunningTurn();
    await logFor(run).append([chunk("private")]);
    const probe = async ({
      db = scopedDbA,
      organizationId = ids.orgA,
      userId = ids.userA1,
      threadId = run.threadId,
    } = {}) =>
      await probeChatTurn.handler(
        asTestRaw<Parameters<typeof probeChatTurn.handler>[0]>({
          getWorkspaceAccess: async () => ({ id: ids.wsA1, status: "active" }),
          memberRole: sessionMemberRole("owner"),
          params: { threadId, turnId: run.execution.id },
          query: { workspaceId: ids.wsA1 },
          request: new Request(
            `http://localhost/v1/chat/threads/${threadId}/turns/${run.execution.id}/resume`,
          ),
          route: "/v1/chat/threads/:threadId/turns/:turnId/resume",
          safeDb: toSafeDbMock(db),
          scopedDb: db,
          session: { activeOrganizationId: organizationId },
          set: { headers: {}, status: 200 },
          user: { id: userId },
        }),
      );
    expect(await probe()).toEqual({
      type: "running",
      turnId: run.execution.id,
      runId: run.runId,
    });
    const unknown = await probe({
      threadId: toSafeId<"chatThread">(Bun.randomUUIDv7()),
    });
    expect(unknown).toMatchObject({ code: 404 });
    for (const refused of [
      await probe({
        db: scopedDbB,
        organizationId: ids.orgB,
        userId: ids.userB1,
      }),
      await probe({ userId: ids.userA2 }),
      unknown,
    ]) {
      expect(refused).toEqual(unknown);
    }
  });

  test("large catch-up replaces deltas with a transcript snapshot then tails without text duplication", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    const messageId = "catch-up-answer";
    const deltas = Array.from({ length: 260 }, (_, index) => `${index},`);
    await log.append([
      { type: EventType.RUN_STARTED, threadId: run.threadId, runId: run.runId },
      { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
      ...deltas.map(
        (delta) =>
          ({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta,
          }) satisfies StreamChunk,
      ),
    ]);
    const replay =
      (await createChatRunLogReplay({
        db: scopedDbA,
        organizationId: ids.orgA,
        runId: run.runId,
        resumeOffset: "-1",
      })) ?? panic("Expected replay");
    const reader = replay.read("-1")[Symbol.asyncIterator]();
    const first = await reader.next();
    if (first.done) {
      panic("Expected catch-up snapshot");
    }
    expect(first.value.chunk.type).toBe(EventType.MESSAGES_SNAPSHOT);
    expect(first.value.offset).toBe("262");
    const { processor } = createStreamMessageCapture({
      initialMessages: [],
      capture: (message) => message,
    });
    processor.processChunk(first.value.chunk);
    const suffix: StreamChunk[] = [
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: "tail" },
      { type: EventType.TEXT_MESSAGE_END, messageId },
      {
        type: EventType.RUN_FINISHED,
        threadId: run.threadId,
        runId: run.runId,
      },
    ];
    await log.append(suffix);
    await log.close();
    const tail = [];
    for (;;) {
      const next = await reader.next();
      if (next.done) {
        break;
      }
      tail.push(next.value.chunk);
      processor.processChunk(next.value.chunk);
    }
    expect(tail).toEqual(suffix);
    expect(processor.getMessages().at(0)?.parts).toEqual([
      { type: "text", content: `${deltas.join("")}tail` },
    ]);
  });

  test("delivery disconnect and rejoin preserve every chunk without invoking the producer again", async () => {
    await assertProperty(
      "delivery disconnect and rejoin preserve every chunk without invoking the producer again",
      fc.asyncProperty(
        fc
          .array(fc.string({ minLength: 1, maxLength: 30 }), {
            minLength: 2,
            maxLength: 12,
          })
          .chain((texts) =>
            fc.tuple(
              fc.constant(texts),
              fc.integer({ min: 1, max: texts.length - 1 }),
            ),
          ),
        async ([texts, cut]) => {
          const run = await seedRunningTurn();
          const log = logFor(run);
          const gate = Promise.withResolvers<undefined>();
          const producerClosed = Promise.withResolvers<undefined>();
          const abortController = new AbortController();
          let providerCalls = 0;
          const values = texts.map(chunk);
          const source = (async function* () {
            providerCalls += 1;
            for (const [index, value] of values.entries()) {
              if (index === cut) {
                await gate.promise;
              }
              yield value;
            }
          })();
          const original = toServerSentEventsResponse(source, {
            abortController,
            durability: {
              batch: 1,
              adapter: {
                ...log,
                close: async () => {
                  await log.close();
                  producerClosed.resolve(undefined);
                },
              },
            },
          });
          const delivery =
            original.body?.getReader() ?? panic("Expected SSE delivery");
          const decoder = new TextDecoder();
          let prefix = "";
          // The accepted marker precedes the generated chunks; stop at a generated boundary.
          while (prefix.split("data: ").length - 1 < cut + 1) {
            const read = await delivery.read();
            if (read.done) {
              panic("Producer ended before disconnect boundary");
            }
            prefix += decoder.decode(read.value);
          }
          const offset =
            prefix
              .match(/id: ([0-9]+)/gu)
              ?.at(-1)
              ?.slice(4) ?? panic("Expected durable offset");
          await delivery.cancel();
          expect(abortController.signal.aborted).toBe(false);
          const replay =
            (await createChatRunLogReplay({
              db: scopedDbA,
              organizationId: ids.orgA,
              runId: run.runId,
              resumeOffset: offset,
            })) ?? panic("Expected an open replay");
          const resumed = toServerSentEventsResponse(
            (async function* () {
              providerCalls += 1;
              yield chunk("must not run");
            })(),
            { durability: { adapter: replay } },
          ).text();
          gate.resolve(undefined);
          const tail = await resumed;
          await producerClosed.promise;
          const delivered = (prefix + tail)
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)));
          // The SDK's acceptance marker is delivery metadata, not provider output.
          expect(delivered.slice(1)).toEqual(values);
          expect(providerCalls).toBe(1);
          expect(
            (await log.snapshot()).slice(1).map(({ chunk: value }) => value),
          ).toEqual(values);
        },
      ),
      { numRuns: 12 },
    );
  });

  test("rejoin uses only the authorized organization and falls back after log closure or retention", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([chunk("private")]);
    const replay = await createChatRunLogReplay({
      db: scopedDbA,
      organizationId: ids.orgA,
      runId: run.runId,
      resumeOffset: "-1",
    });
    expect(replay).not.toBeNull();
    expect(
      await createChatRunLogReplay({
        db: scopedDbB,
        organizationId: ids.orgB,
        runId: run.runId,
        resumeOffset: "-1",
      }),
    ).toBeNull();
    await log.close();
    expect(
      await createChatRunLogReplay({
        db: scopedDbA,
        organizationId: ids.orgA,
        runId: run.runId,
        resumeOffset: "-1",
      }),
    ).toBeNull();
    await testDb
      .delete(chatRunLogEntries)
      .where(eq(chatRunLogEntries.runId, run.runId));
    await testDb.delete(chatRunLogs).where(eq(chatRunLogs.runId, run.runId));
    expect(
      await createChatRunLogReplay({
        db: scopedDbA,
        organizationId: ids.orgA,
        runId: run.runId,
        resumeOffset: "-1",
      }),
    ).toBeNull();
  });

  test("settlement closes an existing run log", async () => {
    const run = await seedRunningTurn();
    await logFor(run).append([chunk("before settlement")]);
    const settled = await scopedDbA(
      async (tx) =>
        await settleChatTurnOnTx({
          assistantMessageId: null,
          execution: run.execution,
          outcome: USER_STOP_OUTCOME,
          tx,
        }),
    );
    expect(settled).toBe("settled");
    const [header] = await testDb
      .select({ closedAt: chatRunLogs.closedAt })
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, run.runId));
    expect(header?.closedAt).toBeInstanceOf(Date);
  });

  test("settlement before delivery logging creates no log rows", async () => {
    const run = await seedRunningTurn();
    await scopedDbA(
      async (tx) =>
        await settleChatTurnOnTx({
          assistantMessageId: null,
          execution: run.execution,
          outcome: USER_STOP_OUTCOME,
          tx,
        }),
    );
    const headers = await testDb
      .select()
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, run.runId));
    const entries = await testDb
      .select()
      .from(chatRunLogEntries)
      .where(eq(chatRunLogEntries.runId, run.runId));
    expect(headers).toEqual([]);
    expect(entries).toEqual([]);
  });

  test("reaping closes a run log after its execution lease expires", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([chunk("before reap")]);
    await rawDb.transaction(async (tx) => {
      await tx
        .update(chatTurns)
        .set({
          createdAt: sql`now() - interval '2 minutes'`,
          leaseExpiresAt: sql`now() - interval '1 minute'`,
        })
        .where(eq(chatTurns.id, run.execution.id));
    });
    await scopedDbA(
      async (tx) =>
        await reapOwnerlessChatTurnOnTx({ threadId: run.threadId, tx }),
    );
    const [header] = await testDb
      .select({ closedAt: chatRunLogs.closedAt })
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, run.runId));
    expect(header?.closedAt).toBeInstanceOf(Date);
  });

  test("retry after an ambiguous commit matches canonical persisted JSON", async () => {
    const run = await seedRunningTurn();
    let injectPostCommitFailure = true;
    const flakyDb: ScopedDb = async (fn) => {
      const result = await scopedDbA(fn);
      if (injectPostCommitFailure) {
        injectPostCommitFailure = false;
        throw new Error("injected response loss after commit");
      }
      return result;
    };
    const log = logFor(run, flakyDb);
    const withUndefined = {
      type: EventType.CUSTOM,
      name: "test",
      value: { omittedByJsonb: undefined, kept: true },
    } satisfies StreamChunk;
    expect(await rejectionMessage(log.append([withUndefined]))).toContain(
      "injected response loss after commit",
    );
    expect(await log.append([withUndefined])).toEqual(["1"]);
    await log.close();
  });

  test("sweep closes an open log whose turn is no longer running", async () => {
    const run = await seedRunningTurn();
    const log = logFor(run);
    await log.append([chunk("abandoned")]);
    await rawDb.transaction(async (tx) => {
      await tx
        .update(chatTurns)
        .set({
          executionId: null,
          interruptionReason: "owner-lost",
          leaseExpiresAt: null,
          settledAt: sql`now()`,
          status: "interrupted",
        })
        .where(eq(chatTurns.id, run.execution.id));
    });
    const result = await sweepClosedChatRunLogs(rawDb);
    expect(result.logsClosed).toBeGreaterThanOrEqual(1);
    const [header] = await testDb
      .select({ closedAt: chatRunLogs.closedAt })
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, run.runId));
    expect(header?.closedAt).toBeInstanceOf(Date);
  });

  test("sweep caps entry deletion and drains an expired log across batches", async () => {
    const expiredRun = await seedRunningTurn();
    const recentRun = await seedRunningTurn();
    const expired = logFor(expiredRun);
    const recent = logFor(recentRun);
    await expired.append(
      Array.from({ length: 70 }, (_, index) => chunk(`expired ${index}`)),
    );
    await expired.close();
    await recent.close();
    await rawDb.transaction(async (tx) => {
      await tx
        .update(chatRunLogs)
        .set({ closedAt: sql`now() - interval '16 minutes'` })
        .where(eq(chatRunLogs.runId, expiredRun.runId));
    });
    // Each call removes at most 64 entry rows and leaves the header until empty.
    const firstBatch = await sweepClosedChatRunLogs(rawDb);
    expect(firstBatch.entriesDeleted).toBe(64);
    const [expiredHeader] = await testDb
      .select()
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, expiredRun.runId));
    expect(expiredHeader).toBeDefined();
    const remainingEntries = await testDb
      .select({ seq: chatRunLogEntries.seq })
      .from(chatRunLogEntries)
      .where(eq(chatRunLogEntries.runId, expiredRun.runId));
    expect(remainingEntries).toHaveLength(6);
    const secondBatch = await sweepClosedChatRunLogs(rawDb);
    expect(secondBatch.entriesDeleted).toBe(6);
    expect(secondBatch.logsDeleted).toBe(1);
    const [deletedHeader] = await testDb
      .select()
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, expiredRun.runId));
    const [recentHeader] = await testDb
      .select()
      .from(chatRunLogs)
      .where(eq(chatRunLogs.runId, recentRun.runId));
    expect(deletedHeader).toBeUndefined();
    expect(recentHeader).toBeDefined();
  });
});
