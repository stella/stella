import { panic } from "better-result";
import { SQL } from "bun";
import type { ReservedSQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import { createDedicatedConnectionOwner } from "@/api/db/dedicated-connection-slots";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { isRecord } from "@/api/lib/type-guards";

// The existing transport owner opens every dedicated session, including cancellation.
const dedicatedConnectionOwner = createDedicatedConnectionOwner({
  capacity: LIMITS.databaseDedicatedConnectionsPerProcess,
  openClient: (options) => new SQL({ ...options, max: 1 }),
});
const { openLongRunningSql } = dedicatedConnectionOwner;
export const { openMaintenanceSql } = dedicatedConnectionOwner;

const CONNECTION_TIMEOUT_SECONDS = 10;
const CANCELLATION_STATEMENT_TIMEOUT_MS = 5000;
// A cancellation that fails leaves the statement running to its own deadline.
const CANCEL_FAILED_SINK = failureSink({
  event: "db.long_running.cancel_failed",
  expected: [],
});

type LongRunningConnectionOptions = {
  /** Milliseconds; these budgets belong only to this dedicated connection. */
  statementTimeout: number;
  lockTimeout: number;
  signal: AbortSignal;
};

const positiveMilliseconds = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return panic(`${name} must be a finite positive millisecond budget`);
  }
  return value;
};

type ReservableSession = {
  unsafe: (query: string, params?: unknown[]) => PromiseLike<unknown>;
  release: () => void;
  close: () => Promise<void>;
};

type TransactionBudget = Pick<
  LongRunningConnectionOptions,
  "statementTimeout" | "lockTimeout"
>;

type SetTransactionBudget = (budgets: TransactionBudget) => Promise<void>;

type ReservedWorkOptions<T, TSession extends ReservableSession> = {
  reserve: () => Promise<TSession>;
  cancelBackend: (pid: number) => Promise<unknown>;
  signal: AbortSignal;
  work: (
    session: TSession,
    setTransactionBudget: SetTransactionBudget,
  ) => Promise<T>;
};

/** The reserved-session lifecycle shared by dedicated jobs and test adapters. */
export const withDedicatedReservedSession = async <
  T,
  TSession extends ReservableSession,
>({
  reserve,
  cancelBackend,
  signal,
  work,
}: ReservedWorkOptions<T, TSession>): Promise<T> => {
  const reserved = await reserve();
  const guarded = new Proxy(reserved, {
    apply(target, _thisArg, args) {
      signal.throwIfAborted();
      if (typeof target !== "function") {
        return panic("Expected a callable dedicated PostgreSQL session");
      }
      const result: unknown = Reflect.apply(target, target, args);
      return result;
    },
    get(target, property) {
      if (property === "unsafe") {
        return (...args: Parameters<TSession["unsafe"]>) => {
          signal.throwIfAborted();
          return Reflect.apply(target.unsafe, target, args);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      const bound: unknown =
        typeof value === "function" ? value.bind(target) : value;
      return bound;
    },
  });
  let cancelling: Promise<unknown> | undefined;
  let onAbort: (() => void) | undefined;
  const body = (async () => {
    const rows = await reserved.unsafe("SELECT pg_backend_pid() AS pid");
    if (!Array.isArray(rows)) {
      return panic("Expected an array from the dedicated PostgreSQL session");
    }
    const pid = rows.find(isRecord)?.["pid"];
    if (typeof pid !== "number") {
      return panic("Expected the dedicated PostgreSQL backend pid");
    }
    onAbort = () => {
      if (cancelling !== undefined) {
        return;
      }
      cancelling = Promise.allSettled([
        (async () => {
          await cancelBackend(pid);
        })(),
      ]).then(([result]) => {
        if (result.status === "rejected") {
          observeFailure(result.reason, {
            sink: CANCEL_FAILED_SINK,
            ctx: { step: "cancel_backend" },
          });
        }
        return undefined;
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      signal.throwIfAborted();
    }
    return await work(guarded, async ({ statementTimeout, lockTimeout }) => {
      const statementBudget = positiveMilliseconds(
        statementTimeout,
        "statementTimeout",
      );
      const lockBudget = positiveMilliseconds(lockTimeout, "lockTimeout");
      await guarded.unsafe(`SET LOCAL lock_timeout = '${lockBudget}ms'`);
      await guarded.unsafe(
        `SET LOCAL statement_timeout = '${statementBudget}ms'`,
      );
    });
  })();
  await Promise.allSettled([body]);
  if (onAbort !== undefined) {
    signal.removeEventListener("abort", onAbort);
  }
  if (cancelling === undefined) {
    reserved.release();
  } else {
    await cancelling;
    await reserved.close();
  }
  return await body;
};

const databaseFor = (client: SQL) =>
  drizzle({ client, relations: databaseRelations });

type LongRunningHandle = {
  /** Drizzle is bound to the reserved session, not an application pool. */
  db: ReturnType<typeof databaseFor>;
  /** Raw SQL is available for maintenance statements Drizzle cannot express. */
  connection: ReservedSQL;
  /** Installs a shorter LOCAL budget on this reserved connection. */
  setTransactionBudget: SetTransactionBudget;
};

/**
 * Owns one connection for bounded maintenance work. Abort cancels the backend
 * through a separate short-lived connection, then closes the aborted session
 * after cancellation settles so a late cancel cannot affect the next borrower.
 */
export const withLongRunningConnection = async <T>(
  { statementTimeout, lockTimeout, signal }: LongRunningConnectionOptions,
  work: (handle: LongRunningHandle) => Promise<T>,
): Promise<T> => {
  const statementBudget = positiveMilliseconds(
    statementTimeout,
    "statementTimeout",
  );
  const lockBudget = positiveMilliseconds(lockTimeout, "lockTimeout");
  signal.throwIfAborted();
  const { envBase } = await import("@/api/env-base");
  const dedicated = await openLongRunningSql({
    url: envBase.DATABASE_URL,
    connectionTimeout: CONNECTION_TIMEOUT_SECONDS,
    statementTimeout: statementBudget,
    lockTimeout: lockBudget,
    cancellationStatementTimeout: CANCELLATION_STATEMENT_TIMEOUT_MS,
    signal,
  });
  try {
    const dedicatedResult = await withDedicatedReservedSession({
      reserve: async () => await dedicated.client.reserve({ signal }),
      cancelBackend: dedicated.cancelBackend,
      signal,
      work: async (reserved, setTransactionBudget) => {
        const workResult = await work({
          db: databaseFor(reserved),
          connection: reserved,
          setTransactionBudget: async ({
            statementTimeout: requestedStatementTimeout,
            lockTimeout: requestedLockTimeout,
          }) => {
            const requestedStatement = positiveMilliseconds(
              requestedStatementTimeout,
              "statementTimeout",
            );
            const requestedLock = positiveMilliseconds(
              requestedLockTimeout,
              "lockTimeout",
            );
            await setTransactionBudget({
              statementTimeout: Math.min(requestedStatement, statementBudget),
              lockTimeout: Math.min(requestedLock, lockBudget),
            });
          },
        });
        signal.throwIfAborted();
        return workResult;
      },
    });
    signal.throwIfAborted();
    return dedicatedResult;
  } finally {
    await dedicated.end();
  }
};
