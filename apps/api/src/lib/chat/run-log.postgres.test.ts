import { EventType, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import {
  readChatTurnTiming,
  settleChatTurnOnTx,
  USER_STOP_OUTCOME,
} from "@/api/handlers/chat/chat-turn-persistence";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createChatRunLog,
  createChatRunLogReplay,
} from "@/api/lib/chat/run-log";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// Keep the real statements and READ COMMITTED sessions: the producer commits
// after the reader's header SELECT and before its entries SELECT executes.
const beforeQuery = <Builder extends object>(
  builder: Builder,
  before: () => Promise<void>,
): Builder =>
  new Proxy(builder, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "then") {
        return async (...args: unknown[]) => {
          await before();
          return await Reflect.apply(value, target, args);
        };
      }
      return (...args: unknown[]) => {
        const next: unknown = Reflect.apply(value, target, args);
        return typeof next === "object" && next !== null
          ? beforeQuery(next, before)
          : next;
      };
    },
  });

if (!databaseUrl || !runPostgresTests) {
  describe.skip("chat delivery durability (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("chat delivery durability (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl, { max: 2 });
    const organizationId = mintAuthProviderId<"organization">();
    const userId = mintAuthProviderId<"user">();
    const threadId = createSafeId<"chatThread">();
    const racedThreadId = createSafeId<"chatThread">();
    const turnId = createSafeId<"chatTurn">();
    const messageId = createSafeId<"chatMessage">();
    const runId = Bun.randomUUIDv7();
    const executionId = Bun.randomUUIDv7();
    const scopedDb = createScopedDb(
      markRlsDatabase(db),
      [],
      organizationId,
      userId,
    );
    beforeAll(async () => {
      await db.insert(user).values({
        id: userId,
        name: "Delivery test",
        email: `${userId}@example.test`,
      });
      await db.insert(organization).values([
        {
          id: organizationId,
          name: "Delivery test",
          slug: organizationId,
          createdAt: new Date(),
        },
      ]);
      await db.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId,
          role: "owner",
          createdAt: new Date(),
        },
      ]);
      await db.insert(chatThreads).values({
        id: threadId,
        organizationId,
        userId,
        title: "Delivery test",
      });
      await db.insert(chatMessages).values({
        id: messageId,
        threadId,
        userId,
        role: "user",
        content: toPersistedChatMessageContentV3({
          data: [{ type: "text", content: "Continue" }],
        }),
      });
      await db.insert(chatTurns).values({
        id: turnId,
        organizationId,
        userId,
        threadId,
        userMessageId: messageId,
        runId,
        executionId,
        status: "running",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
    });
    cleanUp(async () => {
      await db
        .delete(chatThreads)
        .where(inArray(chatThreads.id, [threadId, racedThreadId]));
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    });

    test("replay fences a final batch committed between header and entries until settlement", async () => {
      const execution = {
        id: createSafeId<"chatTurn">(),
        executionId: Bun.randomUUIDv7(),
      };
      const racedRunId = Bun.randomUUIDv7();
      const incomingMessageId = createSafeId<"chatMessage">();
      await db.insert(chatThreads).values({
        id: racedThreadId,
        organizationId,
        userId,
        title: "Replay fence test",
      });
      await db.insert(chatMessages).values({
        id: incomingMessageId,
        threadId: racedThreadId,
        userId,
        role: "user",
        content: toPersistedChatMessageContentV3({
          data: [{ type: "text", content: "Race" }],
        }),
      });
      await db.insert(chatTurns).values({
        id: execution.id,
        organizationId,
        userId,
        threadId: racedThreadId,
        userMessageId: incomingMessageId,
        runId: racedRunId,
        executionId: execution.executionId,
        status: "running",
        activeDurationMs: 0,
        activeStartedAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const log = createChatRunLog({
        db: scopedDb,
        execution,
        organizationId,
        runId: racedRunId,
      });
      const prefix = {
        type: EventType.TEXT_MESSAGE_START,
        role: "assistant",
        messageId: "answer",
      } satisfies StreamChunk;
      const end = {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "answer",
        metadata: { turnTiming: null },
      } satisfies StreamChunk;
      const terminal = {
        type: EventType.RUN_FINISHED,
        runId: racedRunId,
        threadId: racedThreadId,
      } satisfies StreamChunk;
      await log.append([prefix]);
      let selections = 0;
      let committed = false;
      const racingDb: ScopedDb = async (callback) =>
        await scopedDb(
          async (tx) =>
            await callback(
              new Proxy(tx, {
                get(target, property) {
                  if (property !== "select") {
                    return Reflect.get(target, property);
                  }
                  return new Proxy(target.select, {
                    apply(call, thisArg, args) {
                      const builder: unknown = Reflect.apply(
                        call,
                        thisArg,
                        args,
                      );
                      selections += 1;
                      if (
                        selections !== 2 ||
                        typeof builder !== "object" ||
                        builder === null
                      ) {
                        return builder;
                      }
                      return beforeQuery(builder, async () => {
                        await log.append([end, terminal]);
                        committed = true;
                      });
                    },
                  });
                },
              }),
            ),
        );
      const replayStream = createChatRunLog({
        db: racingDb,
        execution,
        organizationId,
        runId: racedRunId,
      }).read("-1");
      const reader = replayStream[Symbol.asyncIterator]();
      expect(await reader.next()).toEqual({
        done: false,
        value: { offset: "1", chunk: prefix },
      });
      expect(committed).toBe(true);
      expect((await log.snapshot()).map(({ chunk }) => chunk)).toEqual([
        prefix,
        end,
        terminal,
      ]);
      const pending = reader.next();
      expect(
        await scopedDb(
          async (tx) =>
            await settleChatTurnOnTx({
              assistantMessageId: null,
              execution,
              outcome: USER_STOP_OUTCOME,
              tx,
            }),
        ),
      ).toBe("settled");
      const timing = await readChatTurnTiming({
        execution,
        safeDb: toSafeDbMock(scopedDb),
      });
      if (Result.isError(timing)) {
        panic("Could not read settled replay timing", timing.error);
      }
      const deliveredEnd = await pending;
      const deliveredTerminal = await reader.next();
      expect(await reader.next()).toEqual({ done: true, value: undefined });
      expect(timing.value?.status).toBe("finished");
      expect(deliveredEnd).toEqual({
        done: false,
        value: {
          offset: "2",
          chunk: { ...end, metadata: { turnTiming: timing.value } },
        },
      });
      expect(deliveredTerminal).toEqual({
        done: false,
        value: { offset: "3", chunk: terminal },
      });
    });

    test("keeps the producer alive after delivery disconnect and replays the exact remaining bytes across scoped sessions", async () => {
      const log = createChatRunLog({
        db: scopedDb,
        execution: { id: turnId, executionId },
        organizationId,
        runId,
      });
      const gate = Promise.withResolvers<undefined>();
      const closed = Promise.withResolvers<undefined>();
      const abortController = new AbortController();
      let providerCalls = 0;
      const chunks = ["First.", " Second.", " Third."].map(
        (delta) =>
          ({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: "answer",
            delta,
          }) satisfies StreamChunk,
      );
      const response = toServerSentEventsResponse(
        (async function* () {
          providerCalls += 1;
          yield chunks.at(0) ?? panic("Expected first chunk");
          await gate.promise;
          yield* chunks.slice(1);
        })(),
        {
          abortController,
          durability: {
            batch: 1,
            adapter: {
              ...log,
              close: async () => {
                await log.close();
                closed.resolve(undefined);
              },
            },
          },
        },
      );
      const reader =
        response.body?.getReader() ?? panic("Expected SSE delivery");
      const decoder = new TextDecoder();
      let prefix = "";
      while (!prefix.includes("First.")) {
        const read = await reader.read();
        if (read.done) {
          panic("Producer ended before disconnect");
        }
        prefix += decoder.decode(read.value);
      }
      const offset =
        prefix
          .match(/id: ([0-9]+)/gu)
          ?.at(-1)
          ?.slice(4) ?? panic("Missing durable offset");
      await reader.cancel();
      expect(abortController.signal.aborted).toBe(false);
      const replay =
        (await createChatRunLogReplay({
          db: scopedDb,
          organizationId,
          runId,
          resumeOffset: offset,
        })) ?? panic("Expected replay");
      const resumed = toServerSentEventsResponse(
        (async function* () {
          providerCalls += 1;
        })(),
        { durability: { adapter: replay } },
      ).text();
      gate.resolve(undefined);
      const tail = await resumed;
      await closed.promise;
      const delivered = (prefix + tail)
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      expect(delivered.slice(1)).toEqual(chunks);
      expect(providerCalls).toBe(1);
      expect(
        await createChatRunLogReplay({
          db: scopedDb,
          organizationId,
          runId,
          resumeOffset: offset,
        }),
      ).toBeNull();
    });
  });
}
