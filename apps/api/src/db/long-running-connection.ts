import { panic, Result } from "better-result";
import type { ReservedSQL, SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";

import type { databaseRelations } from "@/api/db/database-relations";
import {
  createDedicatedConnectionOwner,
  DEDICATED_CONNECTIONS_PER_PROCESS,
} from "@/api/db/dedicated-connection-slots";
import {
  positiveDedicatedTimeoutMilliseconds,
  setDedicatedStatementTimeout,
} from "@/api/db/dedicated-connection-timeouts";
import { createDatabase, createSqlClient } from "@/api/db/sql-client";
import { terminateReserved } from "@/api/db/sql-close";
import { instrumentDedicatedSqlCounts } from "@/api/lib/db-query-counter";
import { failureSink } from "@/api/lib/observability/failure";
import { isRecord } from "@/api/lib/type-guards";

// The existing transport owner opens every dedicated session, including cancellation.
const dedicatedConnectionOwner = createDedicatedConnectionOwner({
  capacity: DEDICATED_CONNECTIONS_PER_PROCESS,
  openClient: (options, purpose) =>
    instrumentDedicatedSqlCounts(
      createSqlClient({ ...options, max: 1 }),
      purpose === "cancellation" ? "cleanup" : "work",
    ),
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

type ReservableSession = {
  unsafe: (query: string, params?: unknown[]) => PromiseLike<unknown>;
  release: () => Promise<void>;
  close: () => Promise<void>;
};

type CancellableReservedSessionOptions<TSession extends ReservableSession> = {
  reserve: () => Promise<TSession>;
  cancelBackend: (pid: number) => Promise<unknown>;
  signal: AbortSignal;
};

type CancellableReservedSession<TSession extends ReservableSession> = {
  session: TSession;
  close: () => Promise<void>;
};

/** Reserves a backend until cancellation settles, then closes it if aborted. */
export const openCancellableReservedSession = async <
  TSession extends ReservableSession,
>({
  reserve,
  cancelBackend,
  signal,
}: CancellableReservedSessionOptions<TSession>): Promise<
  CancellableReservedSession<TSession>
> => {
  const runInCaller = AsyncLocalStorage.snapshot();
  const reserved = await reserve();
  let cancelling: Promise<unknown> | undefined;
  let onAbort: (() => void) | undefined;
  let state: "open" | "closing" | "closed" = "open";

  const close = async () => {
    if (state !== "open") {
      panic("Cancellable reserved session already closing");
    }
    state = "closing";
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
    if (cancelling === undefined) {
      await reserved.release();
    } else {
      await cancelling;
      await terminateReserved(reserved);
    }
    state = "closed";
  };

  try {
    const rows = await reserved.unsafe("SELECT pg_backend_pid() AS pid");
    if (!Array.isArray(rows)) {
      panic("Expected an array from the dedicated PostgreSQL session");
    }
    const pid = rows.find(isRecord)?.["pid"];
    if (typeof pid !== "number") {
      panic("Expected the dedicated PostgreSQL backend pid");
    }
    onAbort = () =>
      runInCaller(() => {
        if (cancelling !== undefined) {
          return;
        }
        cancelling = Promise.allSettled([
          (async () => {
            await cancelBackend(pid);
          })(),
        ]).then(async ([result]) => {
          if (result.status === "rejected") {
            const { observeFailure } =
              await import("@/api/lib/observability/observe-failure");
            observeFailure(result.reason, {
              sink: CANCEL_FAILED_SINK,
              ctx: { step: "cancel_backend" },
            });
          }
          return undefined;
        });
      });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      signal.throwIfAborted();
    }

    const session = new Proxy(reserved, {
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
    return { session, close };
  } catch (error) {
    await close();
    throw error;
  }
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
  const { session, close } = await openCancellableReservedSession({
    reserve,
    cancelBackend,
    signal,
  });
  const body = (async () =>
    work(session, async ({ statementTimeout, lockTimeout }) => {
      const statementBudget = positiveDedicatedTimeoutMilliseconds(
        statementTimeout,
        "statementTimeout",
      );
      const lockBudget = positiveDedicatedTimeoutMilliseconds(
        lockTimeout,
        "lockTimeout",
      );
      await session.unsafe(`SET LOCAL lock_timeout = '${lockBudget}ms'`);
      await setDedicatedStatementTimeout(
        async (statement) => await session.unsafe(statement),
        statementBudget,
      );
    }))();
  await Promise.allSettled([body]);
  await close();
  return await body;
};

const databaseFor = (client: SQL, relations: typeof databaseRelations) =>
  createDatabase({ client, relations });

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
  const statementBudget = positiveDedicatedTimeoutMilliseconds(
    statementTimeout,
    "statementTimeout",
  );
  const lockBudget = positiveDedicatedTimeoutMilliseconds(
    lockTimeout,
    "lockTimeout",
  );
  signal.throwIfAborted();
  const [{ envBase }, { databaseRelations }, { assertDatabaseLoginPosture }] =
    await Promise.all([
      import("@/api/env-base"),
      import("@/api/db/database-relations"),
      import("@/api/lib/db/assert-database-login-posture"),
    ]);
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
        const db = databaseFor(reserved, databaseRelations);
        await assertDatabaseLoginPosture(db);
        const workResult = await work({
          db,
          connection: reserved,
          setTransactionBudget: async ({
            statementTimeout: requestedStatementTimeout,
            lockTimeout: requestedLockTimeout,
          }) => {
            const requestedStatement = positiveDedicatedTimeoutMilliseconds(
              requestedStatementTimeout,
              "statementTimeout",
            );
            const requestedLock = positiveDedicatedTimeoutMilliseconds(
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

type DedicatedStatementTimeoutOptions<T> = {
  query: (
    statement: string,
    parameters?: readonly (string | number | null)[],
  ) => Promise<readonly unknown[]>;
  statementTimeoutMs: number;
  work: () => Promise<T>;
};

/** Temporarily budgets an already reserved maintenance session and restores its exact setting. */
export const withDedicatedStatementTimeout = async <T>({
  query,
  statementTimeoutMs,
  work,
}: DedicatedStatementTimeoutOptions<T>): Promise<T> => {
  const budget = positiveDedicatedTimeoutMilliseconds(
    statementTimeoutMs,
    "statementTimeoutMs",
  );
  const previous = (
    await query("SELECT current_setting('statement_timeout') AS timeout")
  ).find(isRecord)?.["timeout"];
  if (typeof previous !== "string") {
    return panic(
      "Dedicated PostgreSQL session did not return statement_timeout",
    );
  }
  await query("SELECT set_config('statement_timeout', $1, false)", [
    `${budget}ms`,
  ]);
  const outcome = await Result.tryPromise({
    try: work,
    catch: (cause) => cause,
  });
  const restoration = await Result.tryPromise({
    try: async () =>
      await query("SELECT set_config('statement_timeout', $1, false)", [
        previous,
      ]),
    catch: (cause) => cause,
  });
  if (outcome.isErr()) {
    throw outcome.error;
  }
  if (restoration.isErr()) {
    throw restoration.error;
  }
  return outcome.value;
};
