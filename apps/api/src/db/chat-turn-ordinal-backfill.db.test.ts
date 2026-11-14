/**
 * A chat turn's position in its thread: what the insert trigger gives a new
 * turn, and what the backfill gives the turns stored before positions.
 *
 * The backfill loses nothing and keeps the order turns were read in: it
 * writes only the position of turns that have none, numbers them as
 * `(created_at, id)` orders them, never changes a position once given, stays
 * below every position the trigger gave, resumes after an interrupted pass,
 * and changes nothing when run again.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql, type SQLChunk, TransactionRollbackError } from "drizzle-orm";
import fc from "fast-check";

import type { Verdict } from "@stll/db-load-gate/health";
import { assertProperty } from "@stll/property-testing";

import { chatMessages, chatThreads, chatTurns } from "@/api/db/schema";
import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { NEWEST_CHAT_TURN_FIRST } from "@/api/lib/chat/turn-order";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type {
  TestDatabase,
  TestDatabaseTransaction,
} from "@/api/tests/security/test-utils";

import { READ_COMMITTED_BEGIN } from "../lib/db/read-committed-unit";
import { createChatTurnOrdinalBackfill } from "./chat-turn-ordinal-backfill";

type Thread = SafeId<"chatThread">;
type Turn = SafeId<"chatTurn">;

let database: TestDatabase;
type FixtureIds = Awaited<ReturnType<typeof getRlsFixture>>["ids"];
let owner: { organizationId: FixtureIds["orgA"]; userId: FixtureIds["userA1"] };
beforeAll(async () => {
  const fixture = await getRlsFixture();
  database = fixture.testDb;
  owner = { organizationId: fixture.ids.orgA, userId: fixture.ids.userA1 };
});
afterAll(async () => {
  await releaseRlsFixture();
});

const NORMAL = { kind: "normal", signals: [] } satisfies Verdict;
/** Every stored start is this instant plus a few microseconds. */
const BASE = "2026-03-01T10:00:00+00";
const SETTLED_AT = new Date("2026-06-01T00:00:00.000Z");

// Repairs own transactions; savepoints preserve their commit/rollback
// semantics while the surrounding test rolls the fixture back.
const translateTransactionControl = (query: string) => {
  switch (query) {
    case "BEGIN":
    case READ_COMMITTED_BEGIN:
      return "SAVEPOINT chat_turn_ordinal_backfill";
    case "COMMIT":
      return "RELEASE SAVEPOINT chat_turn_ordinal_backfill";
    case "ROLLBACK":
      return "ROLLBACK TO SAVEPOINT chat_turn_ordinal_backfill";
    default:
      return query;
  }
};

type Connection = {
  query: (query: string, params?: readonly unknown[]) => Promise<unknown[]>;
  execute: (query: string, params?: readonly unknown[]) => Promise<void>;
  release: () => undefined;
};

const onlineConnection = (
  transaction: TestDatabaseTransaction,
  /** Fails the statement it is given, to interrupt a pass. */
  failOn: (query: string) => boolean = () => false,
): Connection => {
  const run = async (query: string, params: readonly unknown[]) => {
    if (failOn(query)) {
      throw new Error("Interrupted");
    }
    const statement = translateTransactionControl(query);
    const chunks: SQLChunk[] = [];
    for (const [index, segment] of statement.split(/\$(\d+)/gu).entries()) {
      chunks.push(
        index % 2 === 0
          ? sql.raw(segment)
          : sql`${params[Number(segment) - 1]}`,
      );
    }
    return (await transaction.execute(sql.join(chunks))).rows;
  };
  return {
    query: async (query, params = []) => await run(query, params),
    execute: async (query, params = []) => {
      await run(query, params);
    },
    release: () => undefined,
  };
};

const withFixture = async (
  work: (transaction: TestDatabaseTransaction) => Promise<void>,
) => {
  const result = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`RESET ROLE`);
        await transaction.execute(
          sql`DELETE FROM database_backfill_states WHERE name = 'chat-turn-ordinals'`,
        );
        await work(transaction);
        transaction.rollback();
      }),
    catch: (error) => error,
  });
  if (result.isErr() && !(result.error instanceof TransactionRollbackError)) {
    throw result.error;
  }
};

const newThread = async (
  transaction: TestDatabaseTransaction,
): Promise<Thread> => {
  const id = createSafeId<"chatThread">();
  await transaction.insert(chatThreads).values({
    id,
    organizationId: owner.organizationId,
    userId: owner.userId,
    title: "Turn positions",
  });
  return id;
};

/**
 * A settled turn of the thread, started `microseconds` after `BASE`. Whatever
 * position the row asks for, the trigger gives it the thread's next.
 */
const newTurn = async (
  transaction: TestDatabaseTransaction,
  threadId: Thread,
  {
    microseconds = 0,
    ordinal,
  }: { microseconds?: number; ordinal?: number } = {},
): Promise<Turn> => {
  const userMessageId = createSafeId<"chatMessage">();
  await transaction.insert(chatMessages).values({
    id: userMessageId,
    threadId,
    userId: owner.userId,
    role: "user",
    content: toPersistedChatMessageContentV3({
      data: [{ type: "text", content: "Question" }],
    }),
  });
  const id = createSafeId<"chatTurn">();
  await transaction.insert(chatTurns).values({
    id,
    organizationId: owner.organizationId,
    userId: owner.userId,
    threadId,
    userMessageId,
    status: "cancelled",
    cancellationReason: "user-stop",
    settledAt: SETTLED_AT,
    createdAt: sql`${BASE}::timestamptz + ${`${String(microseconds)} microseconds`}::interval`,
    ...(ordinal === undefined ? {} : { ordinal }),
  });
  return id;
};

const inThreads = (threadIds: readonly Thread[]) =>
  sql.join(
    threadIds.map((id) => sql`${id}`),
    sql`, `,
  );

/** The threads' turns as they were stored before turns carried a position. */
const forgetPositions = async (
  transaction: TestDatabaseTransaction,
  threadIds: readonly Thread[],
) => {
  await transaction.execute(
    sql`UPDATE chat_turns SET ordinal = NULL WHERE thread_id IN (${inThreads(threadIds)})`,
  );
  await transaction.execute(
    sql`UPDATE chat_threads SET last_turn_ordinal = NULL WHERE id IN (${inThreads(threadIds)})`,
  );
};

type TurnSnapshot = {
  id: string;
  thread_id: string;
  ordinal: number | null;
  /** The turn's place in its thread as `(created_at, id)` orders it. */
  stored_position: string;
  /** Every other column, as JSON. */
  rest: string;
};

const snapshot = async (
  transaction: TestDatabaseTransaction,
  threadIds: readonly Thread[],
) =>
  (
    await transaction.execute(
      sql`SELECT id::text AS id, thread_id::text AS thread_id, ordinal,
            row_number() OVER (PARTITION BY thread_id ORDER BY created_at, id)::text AS stored_position,
            (to_jsonb(turn) - 'ordinal')::text AS rest
          FROM chat_turns turn
          WHERE thread_id IN (${inThreads(threadIds)})
          ORDER BY thread_id, created_at, id`,
    )
  ).rows.map((row) => asTestRaw<TurnSnapshot>(row));

const counterOf = async (
  transaction: TestDatabaseTransaction,
  threadId: Thread,
) => {
  const [row] = (
    await transaction.execute(
      sql`SELECT last_turn_ordinal FROM chat_threads WHERE id = ${threadId}`,
    )
  ).rows.map((value) => asTestRaw<{ last_turn_ordinal: number | null }>(value));
  return row === undefined
    ? panic("the thread is gone")
    : row.last_turn_ordinal;
};

const positionOf = (rows: readonly TurnSnapshot[], id: string) =>
  rows.find((row) => row.id === id)?.ordinal ?? panic("the turn is gone");

const backfill = (batchSize: number) =>
  createChatTurnOrdinalBackfill({
    readVerdict: async () => NORMAL,
    sleep: async () => {},
    log: () => undefined,
    batchSize,
  });

const run = async (connection: Connection, batchSize = 2) =>
  await backfill(batchSize).repair(connection);

test("a new turn takes the next position of its thread, whatever it asked for", async () => {
  await withFixture(async (transaction) => {
    const thread = await newThread(transaction);
    const other = await newThread(transaction);
    expect(await counterOf(transaction, thread)).toBeNull();

    const first = await newTurn(transaction, thread);
    // A row that names a position gets the thread's next all the same.
    const second = await newTurn(transaction, thread, { ordinal: 40 });
    // Another thread counts for itself, as a fork does.
    const elsewhere = await newTurn(transaction, other);

    const rows = await snapshot(transaction, [thread, other]);
    expect(positionOf(rows, first)).toBe(1);
    expect(positionOf(rows, second)).toBe(2);
    expect(positionOf(rows, elsewhere)).toBe(1);
    expect(await counterOf(transaction, thread)).toBe(2);
    expect(await counterOf(transaction, other)).toBe(1);
  });
});

test("a position a deleted turn held is not given out again, and the newest turn holds the largest", async () => {
  await withFixture(async (transaction) => {
    const thread = await newThread(transaction);
    const kept = await newTurn(transaction, thread);
    const discarded = [
      await newTurn(transaction, thread),
      await newTurn(transaction, thread),
    ];
    // An edit of the second message deletes its turn and every later one.
    await transaction.execute(
      sql`DELETE FROM chat_turns WHERE id IN (${sql.join(
        discarded.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    const replacement = await newTurn(transaction, thread);

    const rows = await snapshot(transaction, [thread]);
    expect(positionOf(rows, kept)).toBe(1);
    expect(positionOf(rows, replacement)).toBe(4);
    const [newest] = await transaction
      .select({ id: chatTurns.id })
      .from(chatTurns)
      .where(sql`${chatTurns.threadId} = ${thread}`)
      .orderBy(...NEWEST_CHAT_TURN_FIRST)
      .limit(1);
    expect(newest?.id).toBe(replacement);
  });
});

test("turns stored before positions are numbered in their stored order, and nothing else changes", async () => {
  await withFixture(async (transaction) => {
    const thread = await newThread(transaction);
    const empty = await newThread(transaction);
    // Stored out of order, at starts that differ only in microseconds and at
    // one shared start: the order is the stored one, not the insert order.
    for (const microseconds of [900, 1, 500, 500, 2]) {
      await newTurn(transaction, thread, { microseconds });
    }
    await forgetPositions(transaction, [thread, empty]);
    const before = await snapshot(transaction, [thread]);
    expect(before.map(({ ordinal }) => ordinal)).toEqual(
      before.map(() => null),
    );
    // The fixture reaches the fault: the insert order is not the stored one.
    expect(before.map(({ id }) => id)).not.toEqual(
      before.map(({ id }) => id).toSorted(),
    );

    const connection = onlineConnection(transaction);
    expect((await backfill(2).readCompletion(connection)).type).toBe(
      "incomplete",
    );
    expect(await run(connection)).toEqual({ type: "complete" });
    expect(await backfill(2).readCompletion(connection)).toEqual({
      type: "complete",
    });

    const after = await snapshot(transaction, [thread]);
    expect(after.map(({ id, rest }) => ({ id, rest }))).toEqual(
      before.map(({ id, rest }) => ({ id, rest })),
    );
    expect(after.map(({ ordinal }) => String(ordinal))).toEqual(
      after.map(({ stored_position }) => stored_position),
    );
    expect(await counterOf(transaction, thread)).toBe(before.length);
    // A thread without turns has given out nothing, and still starts at 1.
    expect(await counterOf(transaction, empty)).toBeNull();
    const first = await newTurn(transaction, empty);
    expect(positionOf(await snapshot(transaction, [empty]), first)).toBe(1);

    // Run again: there is nothing left to number, so nothing changes.
    expect(await run(connection)).toEqual({ type: "complete" });
    expect(await snapshot(transaction, [thread])).toEqual(after);
  });
});

test("an interrupted pass resumes where it stopped", async () => {
  await withFixture(async (transaction) => {
    const threads = [
      await newThread(transaction),
      await newThread(transaction),
      await newThread(transaction),
    ];
    for (const thread of threads) {
      await newTurn(transaction, thread, { microseconds: 2 });
      await newTurn(transaction, thread, { microseconds: 1 });
    }
    await forgetPositions(transaction, threads);

    let updates = 0;
    const interrupted = onlineConnection(transaction, (query) => {
      if (!query.includes("UPDATE public.chat_turns")) {
        return false;
      }
      updates += 1;
      return updates > 1;
    });
    expect(
      await run(interrupted, 1).then(
        () => "finished",
        () => "interrupted",
      ),
    ).toBe("interrupted");
    const partial = await snapshot(transaction, threads);
    const numbered = partial.filter(({ ordinal }) => ordinal !== null);
    // One batch of one thread committed; the interrupted one rolled back.
    expect(numbered).toHaveLength(2);

    const connection = onlineConnection(transaction);
    expect((await backfill(1).readCompletion(connection)).type).not.toBe(
      "complete",
    );
    expect(await run(connection, 1)).toEqual({ type: "complete" });
    const after = await snapshot(transaction, threads);
    expect(after.map(({ ordinal }) => String(ordinal))).toEqual(
      after.map(({ stored_position }) => stored_position),
    );
    // What the first pass numbered kept its number.
    for (const { id, ordinal } of numbered) {
      expect(positionOf(after, id)).toBe(ordinal ?? panic("not numbered"));
    }
  });
});

const ACTION = {
  backfill: "backfill",
  delete: "delete",
  insert: "insert",
} as const;

type Action =
  | { type: typeof ACTION.insert; thread: number }
  /** Deletes the thread's turn at `pick`, modulo how many it holds. */
  | { type: typeof ACTION.delete; thread: number; pick: number }
  | { type: typeof ACTION.backfill; batchSize: number };

const threadIndex = fc.integer({ min: 0, max: 1 });
const action: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ type: fc.constant(ACTION.insert), thread: threadIndex }),
  fc.record({
    type: fc.constant(ACTION.delete),
    thread: threadIndex,
    pick: fc.nat({ max: 9 }),
  }),
  fc.record({
    type: fc.constant(ACTION.backfill),
    batchSize: fc.integer({ min: 1, max: 3 }),
  }),
);

test("sends, edits and the backfill in any order keep every position unique, stable and in order", async () => {
  await assertProperty(
    "chat turn positions stay unique, stable and ordered under any interleaving of inserts, deletes and the backfill",
    fc.asyncProperty(
      // Two threads of turns stored before positions, at a few microsecond
      // offsets so starts collide and differ below a millisecond.
      fc.tuple(
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 5 }),
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 5 }),
      ),
      fc.array(action, { maxLength: 10 }),
      async (stored, actions) => {
        await withFixture(async (transaction) => {
          const threads = [
            await newThread(transaction),
            await newThread(transaction),
          ];
          const threadAt = (index: number) =>
            threads.at(index) ?? panic("no such thread");
          for (const [index, starts] of stored.entries()) {
            for (const microseconds of starts) {
              await newTurn(transaction, threadAt(index), { microseconds });
            }
          }
          await forgetPositions(transaction, threads);
          const original = await snapshot(transaction, threads);
          const connection = onlineConnection(transaction);

          /** Every position a turn was ever seen with. */
          const given = new Map<string, { thread: string; ordinal: number }>();
          const inserted = new Set<string>();
          const observe = async () => {
            const rows = await snapshot(transaction, threads);
            for (const { id, ordinal, thread_id: thread } of rows) {
              if (ordinal === null) {
                continue;
              }
              const seen = given.get(id);
              // A position, once given, never changes.
              expect(seen?.ordinal ?? ordinal).toBe(ordinal);
              given.set(id, { thread, ordinal });
            }
            // No position is held twice in a thread, counting deleted turns.
            const held = [...given.values()].map(
              ({ thread, ordinal }) => `${thread}:${String(ordinal)}`,
            );
            expect(new Set(held).size).toBe(held.length);
            return rows;
          };

          for (const step of [
            ...actions,
            { type: ACTION.backfill, batchSize: 2 } as const,
          ]) {
            switch (step.type) {
              case ACTION.insert: {
                const thread = threadAt(step.thread);
                const largest = Math.max(
                  0,
                  ...[...given.values()]
                    .filter((seen) => seen.thread === thread)
                    .map(({ ordinal }) => ordinal),
                );
                const id = await newTurn(transaction, thread);
                inserted.add(id);
                const rows = await observe();
                // Above every position the thread ever gave out.
                expect(positionOf(rows, id)).toBeGreaterThan(largest);
                break;
              }
              case ACTION.delete: {
                const rows = (await observe()).filter(
                  ({ thread_id: thread }) => thread === threadAt(step.thread),
                );
                const target = rows.at(step.pick % Math.max(rows.length, 1));
                if (target !== undefined) {
                  await transaction.execute(
                    sql`DELETE FROM chat_turns WHERE id = ${target.id}`,
                  );
                }
                await observe();
                break;
              }
              case ACTION.backfill: {
                expect(await run(connection, step.batchSize)).toEqual({
                  type: "complete",
                });
                const rows = await observe();
                expect(rows.every(({ ordinal }) => ordinal !== null)).toBe(
                  true,
                );
                break;
              }
              default:
                step satisfies never;
                panic("Unknown action");
            }
          }

          const final = await observe();
          const before = new Map(original.map((row) => [row.id, row]));
          for (const thread of threads) {
            const rows = final.filter(
              ({ thread_id: threadId }) => threadId === thread,
            );
            const old = rows.filter(({ id }) => !inserted.has(id));
            const sent = rows.filter(({ id }) => inserted.has(id));
            // Stored turns keep the order they were read in until now.
            const byStoredOrder = old.toSorted(
              (left, right) =>
                Number(before.get(left.id)?.stored_position) -
                Number(before.get(right.id)?.stored_position),
            );
            expect(
              byStoredOrder.map(({ ordinal }) => ordinal ?? panic("none")),
            ).toEqual(
              old
                .map(({ ordinal }) => ordinal ?? panic("none"))
                .toSorted((left, right) => left - right),
            );
            // Each sits below every turn sent since positions exist.
            const largestOld = Math.max(
              0,
              ...old.map(({ ordinal }) => ordinal ?? 0),
            );
            for (const { ordinal } of sent) {
              expect(ordinal ?? 0).toBeGreaterThan(largestOld);
            }
            // Nothing but the position was written.
            for (const { id, rest } of old) {
              expect(rest).toBe(before.get(id)?.rest ?? panic("unknown turn"));
            }
            // The counter never runs behind a position it gave out.
            const largest = Math.max(
              0,
              ...[...given.values()]
                .filter((seen) => seen.thread === thread)
                .map(({ ordinal }) => ordinal),
            );
            const counter = await counterOf(transaction, thread);
            if (largest > 0 && rows.length > 0) {
              expect(counter ?? 0).toBeGreaterThanOrEqual(
                Math.max(...rows.map(({ ordinal }) => ordinal ?? 0)),
              );
            }
            if (sent.length > 0) {
              expect(counter).toBe(largest);
            }
          }
        });
      },
    ),
  );
});
