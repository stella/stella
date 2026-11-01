import { panic, Result, TaggedError } from "better-result";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { withTimeout } from "@stll/concurrency/with-timeout";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/** Runs `run` in its own transaction on its own connection. */
type TransactionRunner = <T>(
  run: (tx: Transaction) => Promise<T>,
) => Promise<T>;

class LockThenWriteRaceOrder extends TaggedError("LockThenWriteRaceOrder")<{
  message: string;
}> {}

type LockThenWriteRaceOptions<A, B> = {
  /** One transaction runner per actor; each must use its own connection. */
  transactions: Record<"a" | "b", TransactionRunner>;
  /**
   * Tx A: lock, `await pause()`, then write. `pause` returns once tx B has
   * committed, so the write runs against B's committed change.
   */
  a: (tx: Transaction, pause: () => Promise<void>) => Promise<A>;
  /** Tx B: the change that makes a new row match tx A's lock predicate. */
  b: (tx: Transaction) => Promise<B>;
  /** Bound on the whole race; a B that waits on A's locks ends here. */
  timeoutMs?: number;
};

/**
 * Two real transactions in the one order that exposes a lock-then-write
 * race: tx A locks its rows, tx B commits a change that makes another row
 * match A's predicate, then tx A writes and commits. Under READ COMMITTED,
 * A's write sees B's committed row, so a write that re-applies the lock's
 * WHERE reaches it while a write by the locked ids does not.
 *
 * The order is enforced by promises, never by sleeping: A signals from
 * `pause()`, B runs to commit, then A is released. B must change rows A did
 * not lock (an update to an unlocked row, or an insert); a B that waits on
 * A's locks, or an A that never pauses, fails the race by name instead of
 * hanging.
 */
export const withLockThenWriteRace = async <A, B>({
  transactions,
  a,
  b,
  timeoutMs = 10_000,
}: LockThenWriteRaceOptions<A, B>): Promise<{ a: A; b: B }> => {
  const locked = Promise.withResolvers<undefined>();
  const committed = Promise.withResolvers<undefined>();
  const pause = async () => {
    locked.resolve(undefined);
    await committed.promise;
  };
  const first = Result.tryPromise(
    async () => await transactions.a(async (tx) => await a(tx, pause)),
  );
  // A that finishes without pausing never wrote after a concurrent commit.
  const reachedPause = await Promise.race([
    locked.promise.then(() => true),
    first.then(() => false),
  ]);
  if (!reachedPause) {
    const outcome = await first;
    return panic(
      outcome.isErr()
        ? `Tx A failed before it paused: ${String(outcome.error.cause)}`
        : "Tx A finished without calling pause() between its lock and its write",
    );
  }
  const second = await Result.tryPromise(
    async () =>
      await withTimeout(async () => await transactions.b(b), {
        label: "Tx B commit while tx A holds its locks",
        timeoutMs,
      }),
  );
  if (second.isErr()) {
    // Release A so it rolls back and frees whatever B was waiting on.
    committed.reject(
      new LockThenWriteRaceOrder({
        message: "Tx B did not commit while tx A held its locks",
      }),
    );
    await first;
    return panic(
      `Tx B did not commit while tx A held its locks; it must change rows tx A did not lock: ${String(second.error)}`,
    );
  }
  committed.resolve(undefined);
  const outcome = await withTimeout(async () => await first, {
    label: "Tx A write after tx B committed",
    timeoutMs,
  });
  return { a: outcome.unwrap(), b: second.value };
};

/**
 * `tx`, except that the first awaited UPDATE or DELETE of `table` first awaits
 * `pause`. Lets an unmodified handler or store function play tx A: its lock
 * runs, then it stops right before its write.
 */
export const pauseBeforeWrite = (
  tx: Transaction,
  table: PgTable,
  pause: () => Promise<void>,
): Transaction => {
  let paused = false;
  const pausing = <T extends object>(builder: T): T =>
    new Proxy(builder, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "then") {
          return async (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) => {
            if (!paused) {
              paused = true;
              const resumed = await Result.tryPromise(pause);
              if (resumed.isErr()) {
                return reject(resumed.error.cause);
              }
            }
            return Reflect.apply(value, target, [resolve, reject]);
          };
        }
        return (...args: unknown[]) => {
          const next: unknown = Reflect.apply(value, target, args);
          return typeof next === "object" && next !== null
            ? pausing(next)
            : next;
        };
      },
    });
  return new Proxy(tx, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (
        (property === "update" || property === "delete") &&
        typeof value === "function"
      ) {
        return (written: PgTable) => {
          const builder: unknown = Reflect.apply(value, target, [written]);
          if (typeof builder !== "object" || builder === null) {
            return panic("Drizzle returned no write builder");
          }
          return getTableName(written) === getTableName(table)
            ? pausing(builder)
            : builder;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/**
 * A `safeDb` that runs its callback inside `tx` and answers as safeDb does,
 * so a handler can play tx A inside the race's own transaction.
 */
export const safeDbIn = (tx: Transaction) =>
  asTestRaw<SafeDb>(async (run: (current: Transaction) => Promise<unknown>) =>
    Result.ok(await run(tx)),
  );
