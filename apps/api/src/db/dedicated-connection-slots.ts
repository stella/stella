import { panic, Result } from "better-result";
import type { SQL } from "bun";

const SLOT_WEIGHTS = {
  longRunning: 2,
  maintenance: 1,
} as const;

type SlotKind = keyof typeof SLOT_WEIGHTS;
type AcquireSlotsOptions = {
  kind: SlotKind;
  signal?: AbortSignal;
};

type WaitingSlots = AcquireSlotsOptions & {
  resolve: (release: () => void) => void;
  onAbort: () => void;
};

/** One budget for lock sessions, dedicated work, and its cancellation session. */
export const createDedicatedConnectionSlots = (capacity: number) => {
  if (!Number.isSafeInteger(capacity) || capacity < 3) {
    return panic(
      "Dedicated connection capacity must allow a lane and cancellable work",
    );
  }
  let occupied = 0;
  let maintenance: "available" | "held" = "available";
  const waiting: WaitingSlots[] = [];

  const grant = (next: WaitingSlots) => {
    const weight = SLOT_WEIGHTS[next.kind];
    next.signal?.removeEventListener("abort", next.onAbort);
    occupied += weight;
    if (next.kind === "maintenance") {
      maintenance = "held";
    }
    let state: "held" | "released" = "held";
    next.resolve(() => {
      if (state === "released") {
        return panic("Dedicated connection slots released twice");
      }
      state = "released";
      occupied -= weight;
      if (next.kind === "maintenance") {
        maintenance = "available";
      }
      drain();
    });
  };

  const drain = () => {
    // A waiting lane must not block the current lane holder's dedicated work.
    for (let index = 0; index < waiting.length;) {
      const next = waiting.at(index);
      if (next === undefined) {
        return panic("Dedicated connection waiter disappeared");
      }
      const weight = SLOT_WEIGHTS[next.kind];
      if (
        occupied + weight > capacity ||
        (next.kind === "maintenance" && maintenance === "held")
      ) {
        index += 1;
        continue;
      }
      waiting.splice(index, 1);
      grant(next);
    }
  };

  return async ({ kind, signal }: AcquireSlotsOptions): Promise<() => void> => {
    signal?.throwIfAborted();
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: WaitingSlots = {
        kind,
        signal,
        resolve,
        onAbort: () => {
          const index = waiting.indexOf(waiter);
          if (index === -1) {
            return panic("Aborted dedicated connection waiter was not queued");
          }
          waiting.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(signal?.reason);
          drain();
        },
      };
      waiting.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      drain();
    });
  };
};

type OpenLongRunningSqlOptions = {
  url: string;
  connectionTimeout: number;
  statementTimeout: number;
  lockTimeout: number;
  cancellationStatementTimeout: number;
  signal: AbortSignal;
};

type DedicatedSqlClient = {
  unsafe: (
    statement: string,
    params?: unknown[],
  ) => PromiseLike<readonly Record<string, unknown>[]>;
  end: () => Promise<void>;
};

type CreateDedicatedConnectionOwnerOptions<TClient extends DedicatedSqlClient> =
  {
    capacity: number;
    openClient: (options: SQL.PostgresOrMySQLOptions) => TClient;
  };

/** The transport seam keeps admission and close-failure tests on the real owner. */
export const createDedicatedConnectionOwner = <
  TClient extends DedicatedSqlClient,
>({
  capacity,
  openClient,
}: CreateDedicatedConnectionOwnerOptions<TClient>) => {
  const acquireSlots = createDedicatedConnectionSlots(capacity);
  const openLongRunningSql = async ({
    url,
    connectionTimeout,
    statementTimeout,
    lockTimeout,
    cancellationStatementTimeout,
    signal,
  }: OpenLongRunningSqlOptions) => {
    const releaseSlots = await acquireSlots({ kind: "longRunning", signal });
    const opened = Result.try({
      try: () => {
        signal.throwIfAborted();
        return openClient({
          url,
          max: 1,
          idleTimeout: 0,
          connectionTimeout,
          connection: {
            statement_timeout: statementTimeout,
            lock_timeout: lockTimeout,
          },
        });
      },
      catch: (error) => error,
    });
    if (opened.isErr()) {
      releaseSlots();
      throw opened.error;
    }
    const client = opened.value;
    let state: "open" | "closing" = "open";
    type CancellationAttempt = {
      pid: number;
      session: "notOpened" | "open" | "closed";
      promise: Promise<void>;
    };
    let cancellation:
      | { type: "idle" }
      | { type: "started"; attempt: CancellationAttempt } = { type: "idle" };
    return {
      client,
      cancelBackend: (pid: number) => {
        if (state !== "open") {
          return panic(
            "Cancellation requested after dedicated connection closed",
          );
        }
        if (cancellation.type === "started") {
          if (cancellation.attempt.pid !== pid) {
            return panic(
              "Dedicated cancellation requested for a different backend",
            );
          }
          return cancellation.attempt.promise;
        }
        const performCancellation = async () => {
          const canceller = openClient({
            url,
            max: 1,
            idleTimeout: 0,
            connectionTimeout,
            connection: { statement_timeout: cancellationStatementTimeout },
          });
          attempt.session = "open";
          try {
            await canceller.unsafe("SELECT pg_cancel_backend($1)", [pid]);
          } finally {
            await canceller.end();
            attempt.session = "closed";
          }
        };
        const attempt: CancellationAttempt = {
          pid,
          session: "notOpened",
          // Defer opening until this attempt owns its lifecycle state.
          promise: Promise.resolve().then(performCancellation),
        };
        cancellation = { type: "started", attempt };
        return attempt.promise;
      },
      end: async () => {
        if (state === "closing") {
          return panic("Dedicated connection already closing");
        }
        state = "closing";
        // The cancellation caller receives its failure; closing only drains it.
        if (cancellation.type === "started") {
          await Promise.allSettled([cancellation.attempt.promise]);
        }
        await client.end();
        // A failed close keeps its allocation: the backend may still be alive.
        if (
          cancellation.type === "idle" ||
          cancellation.attempt.session !== "open"
        ) {
          releaseSlots();
        }
      },
    };
  };

  const openMaintenanceSql = async (url: string) => {
    const releaseSlots = await acquireSlots({ kind: "maintenance" });
    const opened = Result.try({
      try: () => openClient({ url, max: 1 }),
      catch: (error) => error,
    });
    if (opened.isErr()) {
      releaseSlots();
      throw opened.error;
    }
    const client = opened.value;
    return {
      unsafe: async (statement: string, values: readonly string[] = []) =>
        await client.unsafe(statement, [...values]),
      end: async () => {
        await client.end();
        releaseSlots();
      },
    };
  };
  return { openLongRunningSql, openMaintenanceSql };
};
